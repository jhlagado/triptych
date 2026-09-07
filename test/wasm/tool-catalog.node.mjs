import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { buildBrowserToolCatalog } from "../../tools/lib/browser-tool-catalog.mjs";
import {
  createBlankCpm22Disk,
  installCpm22File,
  readCpm22File,
} from "../../tools/lib/cpm22-disk.mjs";
import {
  fetchToolUpdates,
  identifyInstalledTools,
  validateToolCatalog,
} from "../../crates/triptych-host-wasm/web/tool-catalog.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const copy = (value) => structuredClone(value);

function fixture() {
  let disk = createBlankCpm22Disk();
  const components = [
    ["atom", "ATOM.COM", 129],
    ["nucleus", "NUC.COM", 16385],
    ["edit", "EDIT.COM", 128],
    ["caverns80", "CAVERNS.COM", 22526],
    ["hyperdrive", "HYPERDRV.COM", 15153],
  ].map(([id, name, count], index) => {
    const bytes = new Uint8Array(count).fill(index + 41);
    disk = installCpm22File(disk, { name, bytes });
    return {
      id,
      bytes: bytes.length,
      sha256: hash(bytes),
      source: {
        kind: "git",
        repository: `https://github.com/jhlagado/${id}.git`,
        revision: String(index + 1).repeat(40),
        path: `${id}.asm`,
      },
      target: { origin: 256, capacity: 0xe300 },
      install: { kind: "file", name, padByte: 26 },
    };
  });
  const manifest = {
    schema: "triptych-cpm-distribution-v1",
    targetProfile: "triptych-cpu-v0.1",
    triptych: { revision: "a".repeat(40), dirty: true },
    lockSha256: "b".repeat(64),
    components,
    disk: { bytes: disk.length, logicalBytes: 256256, sha256: hash(disk) },
  };
  const { catalog, assets } = buildBrowserToolCatalog(manifest, disk);
  const calls = [];
  const options = {
    expectedDistribution: manifest,
    baseUrl: "https://example.test/triptych/tools.json",
    crypto: webcrypto,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const bytes = assets.get(new URL(url).pathname.split("/").at(-1));
      return { ok: !!bytes, arrayBuffer: async () => bytes.slice().buffer };
    },
  };
  return { disk, manifest, catalog, assets, calls, options };
}

test("catalog extracts five exact padded applications, including multiple extents", () => {
  const { catalog, assets, disk } = fixture();
  assert.deepEqual(
    catalog.tools.map((tool) => tool.id),
    ["atom", "nucleus", "edit", "caverns80", "hyperdrive"],
  );
  assert.equal(assets.size, 5);
  for (const tool of catalog.tools) {
    assert.deepEqual(assets.get(tool.asset), readCpm22File(disk, tool.name));
    assert.equal(hash(assets.get(tool.asset)), tool.padded.sha256);
    assert.equal(assets.get(tool.asset).length, tool.padded.bytes);
  }
  assert.deepEqual(
    catalog.tools.map((tool) => tool.padded.bytes),
    [256, 16512, 128, 22528, 15232],
  );
  const before = disk.slice();
  assets.values().next().value.fill(0);
  assert.deepEqual(disk, before, "assets cannot mutate distribution media");
});

test("generator rejects mismatched disk, raw identity, padding, filename and duplicate components", () => {
  const { manifest, disk } = fixture();
  const altered = disk.slice();
  altered[0] ^= 1;
  assert.throws(
    () => buildBrowserToolCatalog(manifest, altered),
    /disk digest/,
  );
  const raw = copy(manifest);
  raw.components[0].sha256 = "0".repeat(64);
  assert.throws(() => buildBrowserToolCatalog(raw, disk), /raw digest/);
  const padded = readCpm22File(disk, "ATOM.COM");
  padded[padded.length - 1] = 0;
  const badDisk = installCpm22File(disk, { name: "ATOM.COM", bytes: padded });
  const badPadding = copy(manifest);
  badPadding.disk.sha256 = hash(badDisk);
  assert.throws(
    () => buildBrowserToolCatalog(badPadding, badDisk),
    /record padding/,
  );
  const wrongName = copy(manifest);
  wrongName.components[0].install.name = "EVIL.COM";
  assert.throws(() => buildBrowserToolCatalog(wrongName, disk), /absent/);
  const duplicate = copy(manifest);
  duplicate.components.push(duplicate.components[0]);
  assert.throws(() => buildBrowserToolCatalog(duplicate, disk), /one atom/);
});

test("catalog rejects wrong distribution, source, target, raw hash and unsafe asset names before fetching", async () => {
  const { catalog, options, calls } = fixture();
  const mutations = [
    (value) => {
      value.targetProfile = "other";
    },
    (value) => {
      value.distribution.revision = "c".repeat(40);
    },
    (value) => {
      value.distribution.lockSha256 = "0".repeat(64);
    },
    (value) => {
      value.distribution.diskSha256 = "0".repeat(64);
    },
    (value) => {
      value.tools[0].source.revision = "0".repeat(40);
    },
    (value) => {
      value.tools[0].source.repository = "https://other.test/atom.git";
    },
    (value) => {
      value.tools[0].target.origin = 0;
    },
    (value) => {
      value.tools[0].target.capacity = 65536;
    },
    (value) => {
      value.tools[0].raw.sha256 = "0".repeat(64);
    },
    (value) => {
      value.tools[0].raw.bytes += 1;
    },
    (value) => {
      value.tools[0].padded.bytes += 128;
    },
    (value) => {
      value.tools[0].padded.sha256 = "not-a-hash";
    },
    (value) => {
      value.tools[0].name = "OTHER.COM";
    },
    (value) => {
      value.tools[0].padByte = 0;
    },
    (value) => {
      value.tools[1] = value.tools[0];
    },
    (value) => {
      value.tools[0].id = "bios";
    },
    ...[
      "../ATOM.COM",
      "/ATOM.COM",
      "https://other.test/A.COM",
      "a%2fb.com",
      "a.com?x=1",
      "a\\b.com",
    ].map((asset) => (value) => {
      value.tools[0].asset = asset;
    }),
  ];
  for (const mutate of mutations) {
    const altered = copy(catalog);
    mutate(altered);
    await assert.rejects(
      fetchToolUpdates(altered, ["atom"], options),
      /Tool catalog:/,
    );
  }
  assert.equal(calls.length, 0);
});

test("requires explicit pinned manifest and validates its structural boundaries", () => {
  const { catalog, manifest } = fixture();
  assert.throws(() => validateToolCatalog(catalog), /manifest is required/);
  for (const mutate of [
    (value) => {
      value.disk.bytes -= 128;
    },
    (value) => {
      value.disk.logicalBytes = 0;
    },
    (value) => {
      value.components.push(value.components[0]);
    },
    (value) => {
      value.components = [];
    },
    (value) => {
      value.components[0].source.kind = "triptych";
    },
  ]) {
    const altered = copy(manifest);
    mutate(altered);
    assert.throws(() => validateToolCatalog(catalog, altered), /Tool catalog:/);
  }
});

test("selected-only fetch returns verified copies with no-store and redirect rejection", async () => {
  const { catalog, options, calls, assets } = fixture();
  const result = await fetchToolUpdates(catalog, ["edit", "atom"], options);
  assert.deepEqual(
    result.map((file) => file.name),
    ["EDIT.COM", "ATOM.COM"],
  );
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.match(
      url,
      /^https:\/\/example.test\/triptych\/tool-(?:edit|atom)-[a-f0-9]{64}\.com$/,
    );
    assert.deepEqual(init, { cache: "no-store", redirect: "error" });
  }
  const edit = catalog.tools.find((tool) => tool.id === "edit");
  result[0].bytes.fill(0);
  assert.equal(hash(assets.get(edit.asset)), edit.padded.sha256);
});

test("missing, altered, truncated or wrongly padded asset rejects the complete batch", async () => {
  for (const mode of ["http-error", "raw", "short", "padding", "network"]) {
    const { catalog, options, assets } = fixture();
    const atom = catalog.tools[0];
    const originalFetch = options.fetch;
    options.fetch = async (url, init) => {
      if (!url.endsWith(atom.asset)) return originalFetch(url, init);
      if (mode === "network") throw new Error("offline");
      let bytes = assets.get(atom.asset).slice();
      if (mode === "raw") bytes[0] ^= 1;
      if (mode === "short") bytes = bytes.subarray(0, bytes.length - 1);
      if (mode === "padding") bytes[bytes.length - 1] = 0;
      return {
        ok: mode !== "http-error",
        arrayBuffer: async () => bytes.slice().buffer,
      };
    };
    let staged;
    await assert.rejects(async () => {
      staged = await fetchToolUpdates(catalog, ["edit", "atom"], options);
    }, /verification failed|download failed|offline/);
    assert.equal(staged, undefined);
  }
});

test("even a self-consistent padded hash cannot bypass pinned raw bytes or required padding", async () => {
  const { catalog, options, assets } = fixture();
  const altered = copy(catalog);
  const tool = altered.tools[0];
  const bytes = assets.get(tool.asset).slice();
  bytes[0] ^= 1;
  tool.padded.sha256 = hash(bytes);
  tool.asset = `tool-atom-${tool.padded.sha256}.com`;
  assets.set(tool.asset, bytes);
  await assert.rejects(
    fetchToolUpdates(altered, ["atom"], options),
    /verification failed/,
  );
});

test("identification uses full records; unknown is distinct from missing and errors propagate", async () => {
  const { catalog, disk, options } = fixture();
  const result = await identifyInstalledTools(
    catalog,
    (name) => {
      if (name === "NUC.COM") return undefined;
      const bytes = readCpm22File(disk, name);
      if (name === "ATOM.COM") bytes[bytes.length - 1] = 0;
      return bytes;
    },
    options,
  );
  assert.deepEqual(
    result.map(({ status }) => status),
    ["different-unknown", "missing", "matching", "matching", "matching"],
  );
  await assert.rejects(
    identifyInstalledTools(
      catalog,
      () => {
        throw new Error("corrupt directory");
      },
      options,
    ),
    /corrupt directory/,
  );
  await assert.rejects(
    identifyInstalledTools(catalog, () => null, options),
    /invalid installed bytes/,
  );
});

test("asynchronous requests retain validated selection and catalog snapshot", async () => {
  const { catalog, options } = fixture();
  const mutable = copy(catalog);
  const selected = ["atom"];
  const pending = fetchToolUpdates(mutable, selected, options);
  mutable.tools[0].name = "USER.NU";
  mutable.tools[0].raw.sha256 = "0".repeat(64);
  selected.push("edit");
  const result = await pending;
  assert.deepEqual(
    result.map(({ name }) => name),
    ["ATOM.COM"],
  );
});

test("bad selections and unavailable cryptography fail closed", async () => {
  const { catalog, options, calls } = fixture();
  for (const selection of [[], ["atom", "atom"], ["ccp"], "atom"]) {
    await assert.rejects(
      fetchToolUpdates(catalog, selection, options),
      /Tool catalog:/,
    );
  }
  assert.equal(calls.length, 0);
  await assert.rejects(
    fetchToolUpdates(catalog, ["atom"], {
      ...options,
      baseUrl: "file:///tools.json",
    }),
    /HTTP/,
  );
  await assert.rejects(
    fetchToolUpdates(catalog, ["atom"], { ...options, crypto: {} }),
    /Web Crypto/,
  );
});
