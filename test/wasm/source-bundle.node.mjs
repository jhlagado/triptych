import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import {
  prepareSourceBundle,
  mapSourceBundleOffset,
} from "../../crates/triptych-host-wasm/web/source-bundle.js";

// This test double only checks the adapter's delegation. Real CP/M canonical
// naming is owned by CpmDisk and covered by its browser binding tests.
const options = {
  crypto: webcrypto,
  canonicalName(name) {
    assert.match(name, /^[A-Za-z0-9]{1,8}\.[A-Za-z0-9]{1,3}$/);
    return name.toUpperCase();
  },
};
const bytes = (text) => new TextEncoder().encode(text);
const source = (name, text) => ({ name, bytes: bytes(text) });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const packageSources = (sources, extra = {}) =>
  prepareSourceBundle({ sources, outputName: "GAME.NU", ...extra }, options);
const padded = (value) => Uint8Array.from([...value, 26, 26, 26]);

test("preserves ordered bytes and CRLF, strips only verified EOF padding, maps hashes", async () => {
  const sources = [
    source("IO.NU", "// helpers\r\nsub output()\r\nend\r\n"),
    source("MAIN.NU", "sub main()\nend"),
  ];
  sources[0].bytes = padded(sources[0].bytes);
  const result = await packageSources(sources);
  assert.equal(result.name, "GAME.NU");
  assert.equal(
    new TextDecoder().decode(result.bytes),
    "// helpers\r\nsub output()\r\nend\r\nsub main()\nend\n",
  );
  assert.equal(result.map.sha256, hash(result.bytes));
  assert.equal(
    result.map.sources[0].sha256,
    hash(sources[0].bytes.subarray(0, -3)),
  );
  assert.equal(result.map.sources[0].storedSha256, hash(sources[0].bytes));
  assert.equal(result.map.sources[0].addedNewline, false);
  assert.equal(result.map.sources[1].addedNewline, true);
  assert.equal(result.map.sources[1].start, sources[0].bytes.length - 3);
});

test("EOF line comments and //% import text remain ordinary source, not discovery", async () => {
  const result = await packageSources([
    source("IO.NU", '//% import "MISSING.NU"'),
    source("MAIN.NU", "sub main()\nend"),
  ]);
  assert.equal(
    new TextDecoder().decode(result.bytes),
    '//% import "MISSING.NU"\nsub main()\nend\n',
  );
});

test("names are canonical, unique and cannot overwrite a maintained source", async () => {
  for (const sources of [
    [],
    [source("io.nu", "end")],
    [source("IO.NU", "end"), source("IO.NU", "end")],
    [source("GAME.NU", "end")],
  ]) {
    await assert.rejects(
      packageSources(sources),
      /sources are required|canonical|colliding/,
    );
  }
  await assert.rejects(
    packageSources([source("IO.NU", "end")], { outputName: "game.nu" }),
    /canonical/,
  );
  await assert.rejects(
    prepareSourceBundle({ sources: [], outputName: "GAME.NU" }),
    /canonicalName/,
  );
});

test("missing, empty and padding-only inputs are packaging failures", async () => {
  for (const entry of [
    null,
    { name: "IO.NU" },
    source("IO.NU", ""),
    { name: "IO.NU", bytes: Uint8Array.of(26, 26) },
  ]) {
    await assert.rejects(packageSources([entry]), /missing|empty/);
  }
});

test("rejects data hidden after EOF, unsupported bytes, and lone CR in any context", async () => {
  for (const text of [
    "end\x1aignored",
    "//\x00",
    "\x7f",
    "\x80",
    "\r",
    "// comment\r",
    '"x\r\n"',
  ]) {
    await assert.rejects(
      packageSources([source("IO.NU", text)]),
      /non-padding|unsupported|lone CR|unterminated/,
    );
  }
});

test("no cross-part literals, delimiters or comment continuations", async () => {
  for (const text of [
    '"open',
    "'x",
    '"escaped\\"',
    "sub main(",
    "a[",
    "([)]",
    "]",
    "/* ( */",
  ]) {
    await assert.rejects(
      packageSources([source("IO.NU", text), source("MAIN.NU", "end")]),
      /literal|delimiter/,
    );
  }
  const result = await packageSources([
    source("IO.NU", '// [( "'),
    source("MAIN.NU", '"// ([ \\\""\n\'"\'\n'),
  ]);
  assert.ok(result.bytes.length > 0);
});

test("capacity counts the physical inserted newline, without counter wrap", async () => {
  assert.equal(
    (await packageSources([source("IO.NU", " ".repeat(65534))])).bytes.length,
    65535,
  );
  await assert.rejects(
    packageSources([source("IO.NU", " ".repeat(65535))]),
    /capacity/,
  );
  await assert.rejects(
    packageSources([source("IO.NU", " ".repeat(65536))]),
    /capacity/,
  );
});

test("takes a stable copy of every source before asynchronous hashing", async () => {
  const sources = [source("IO.NU", "// one"), source("MAIN.NU", "end")];
  const pending = packageSources(sources);
  sources[1].bytes.fill(0);
  sources[0].name = "CHANGED.NU";
  const result = await pending;
  assert.equal(new TextDecoder().decode(result.bytes), "// one\nend\n");
  assert.equal(result.map.sources[0].name, "IO.NU");
});

test("maps bytes, CRLF, byte columns, inserted newline and final EOF", async () => {
  const sources = [
    source("IO.NU", "// x\r\n\tend"),
    source("MAIN.NU", "end\n"),
  ];
  const result = await packageSources(sources);
  const locate = (offset) =>
    mapSourceBundleOffset(
      { sources, bundle: result, map: result.map, offset },
      options,
    );
  assert.deepEqual(await locate(7), {
    name: "IO.NU",
    offset: 7,
    line: 2,
    column: 2,
    synthetic: false,
  });
  assert.deepEqual(await locate(10), {
    name: "IO.NU",
    offset: 10,
    line: 2,
    column: 5,
    synthetic: true,
  });
  assert.deepEqual(await locate(11), {
    name: "MAIN.NU",
    offset: 0,
    line: 1,
    column: 1,
    synthetic: false,
  });
  assert.deepEqual(await locate(15), {
    name: "MAIN.NU",
    offset: 4,
    line: 2,
    column: 1,
    synthetic: false,
  });
  await assert.rejects(locate(16), /outside/);
  await assert.rejects(locate(-1), /invalid/);
});

test("maps generated CP/M padding but rejects stale source, output, order and map", async () => {
  const sources = [source("IO.NU", "// x"), source("MAIN.NU", "end")];
  const result = await packageSources(sources);
  const input = {
    sources,
    bundle: { name: result.name, bytes: padded(result.bytes) },
    map: result.map,
    offset: 0,
  };
  assert.equal((await mapSourceBundleOffset(input, options)).name, "IO.NU");
  for (const mutate of [
    (value) => {
      value.sources[0].bytes[3] = 121;
    },
    (value) => {
      value.sources[0].bytes = padded(value.sources[0].bytes);
    },
    (value) => {
      value.sources.reverse();
    },
    (value) => {
      value.bundle.bytes[0] = 32;
    },
    (value) => {
      value.map.sources[0].start = 1;
    },
    (value) => {
      value.map.sha256 = "0".repeat(64);
    },
  ]) {
    const changed = structuredClone(input);
    mutate(changed);
    await assert.rejects(mapSourceBundleOffset(changed, options), /stale/);
  }
});
