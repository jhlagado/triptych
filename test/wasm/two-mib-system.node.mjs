import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  fetchTwoMibSystem,
  admitTwoMibSavedMachine,
} from "../../crates/triptych-host-wasm/web/two-mib-system.js";

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = "a".repeat(64);
const baseUrl = "https://example.test/triptych/index.html";
const word = (bytes, offset, value) => {
  bytes[offset] = value & 255;
  bytes[offset + 1] = value >>> 8;
};

// Deliberately independent synthetic layout fixtures exercise the browser
// contract without importing a Node builder into its production module. They
// are not assembled machine-code qualification or a bootability claim.
function fixture(count) {
  const suffix = `n${String(count).padStart(2, "0")}`;
  const profile = `triptych-cpu-v0.1-2m-${suffix}`;
  const allocationBytes = 256 * Math.ceil(count / 2);
  const allocationBase = 65536 - allocationBytes;
  const biosBase = allocationBase - 1024;
  const bdos = biosBase - 3584;
  const ccp = bdos - 2048;
  const system = new Uint8Array(16384);
  system.fill(Math.ceil(count / 2), 0, 5632);
  const bios = system.subarray(5632, 6656);
  bios[27] = 0xc3;
  word(bios, 28, biosBase + 64);
  bios.set([0x79, 0xfe, count, 0x21, 0, 0, 0xd0], 64);
  bios.set([128, 0, 4, 15, 0, 247, 3, 255, 3, 255, 255, 0, 0, 1, 0], 500);
  for (let drive = 0; drive < count; drive++) {
    for (const [index, value] of [
      0,
      0,
      0,
      0,
      biosBase + 515,
      biosBase + 500,
      biosBase + 643,
      allocationBase + 128 * drive,
    ].entries())
      word(bios, 768 + drive * 16 + index * 2, value);
  }
  const bootstrap = new Uint8Array(256);
  bootstrap.set([0xf3, 0x31]);
  word(bootstrap, 2, ccp - 256);
  word(bootstrap, 16, ccp - 272);
  bootstrap[19] = 52;
  word(bootstrap, 21, ccp - 271);
  word(bootstrap, 24, ccp);
  const source = (path) => ({
    source: path,
    sourceSha256: hash,
    preparedSourceSha256: hash,
  });
  const root = "third_party/portable-cpm/2m/v0.1.4";
  const descriptor = {
    schema: "triptych-two-mib-system-v1",
    id: "triptych-cpm-2m-v1",
    residentProfile: profile,
    configuredCount: count,
    imageBytes: 2097152,
    systemBytes: 16384,
    layout: {
      ccp,
      bdos,
      bios: biosBase,
      allocationBase,
      allocationBytes,
      commonLimit: biosBase + 768,
      dphBase: biosBase + 768,
      dphEnd: biosBase + 768 + 16 * count,
    },
    system: {
      asset: `system-triptych-cpm-2m-${suffix}-v1.bin`,
      bytes: 16384,
      sha256: sha(system),
    },
    bootstrap: {
      asset: `bootstrap-triptych-cpm-2m-${suffix}-v1.bin`,
      bytes: 256,
      sha256: sha(bootstrap),
      ...source("roms/cpu/bootstrap-2m.asm"),
    },
    residents: {
      lock: `distribution/residents-2m/${suffix}.lock.json`,
      lockSha256: hash,
      manifest: `${root}/profiles/${profile}/manifest.json`,
      manifestSha256: hash,
      repository: "https://github.com/jhlagado/portable-cpm.git",
      version: "0.1.4",
      revision: "d28fc52774c967d1422b3b814d51c069247504c1",
      ccp: {
        ...source(`${root}/src/ccp.asm`),
        sha256: sha(system.subarray(0, 2048)),
        offset: 0,
        origin: ccp,
        bytes: 2048,
      },
      bdos: {
        ...source(`${root}/src/bdos.asm`),
        sha256: sha(system.subarray(2048, 5632)),
        offset: 2048,
        origin: bdos,
        bytes: 3584,
      },
    },
    bios: {
      ...source("system/cpm/bios-2m.asm"),
      sha256: sha(bios),
      commonEnd: biosBase + 675,
      directoryBuffer: biosBase + 515,
      dpb: biosBase + 500,
      checksumVector: biosBase + 643,
    },
    atom: {
      repository: "https://github.com/jhlagado/atom.git",
      revision: "802b5c2d320bec777f427755ff2d7338e3b80a05",
      package: "atom-z80",
      seed: {
        bytes: 64236,
        sha256:
          "fdea19fbd8aeb6211469f043491610455a71547902cf451c3e684e49a8fa0fd6",
      },
      packageIntegrity: `sha512-${"A".repeat(86)}==`,
    },
    machine: {
      revision: "b".repeat(40),
      dirty: true,
      generator: "tools/lib/cpm-two-mib-profile.mjs",
      generatorSha256: hash,
    },
  };
  return { descriptor, system, bootstrap };
}

function deployment(...fixtures) {
  return {
    schema: "triptych-browser-deployment-v1",
    diskProfiles: [{ historical: true }],
    twoMibProfiles: fixtures.map(({ descriptor }) =>
      structuredClone(descriptor),
    ),
    assets: fixtures.flatMap(({ descriptor }) =>
      ["system", "bootstrap"].map((kind) => ({
        path: descriptor[kind].asset,
        bytes: descriptor[kind].bytes,
        sha256: descriptor[kind].sha256,
      })),
    ),
  };
}

function snapshot(f, full = false) {
  return {
    schema: "triptych-drive-set-v4",
    configuredCount: f.descriptor.configuredCount,
    bootstrap: {
      profile: f.descriptor.residentProfile,
      bytes: Uint8Array.from(f.bootstrap),
    },
    slots: Array.from({ length: f.descriptor.configuredCount }, (_, index) =>
      index && !full
        ? null
        : {
            instanceId: `12345678-1234-4123-8123-${String(index).padStart(12, "0")}`,
            name: `Drive ${index}`,
            bytes: new Uint8Array(2097152),
          },
    ),
  };
}

function transport(fixtures, hook = () => {}) {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    hook(calls.length);
    const name = new URL(url).pathname.split("/").at(-1);
    for (const f of fixtures)
      for (const kind of ["system", "bootstrap"])
        if (f.descriptor[kind].asset === name) return new Response(f[kind]);
    return new Response(null, { status: 404 });
  };
  return { fetch, calls };
}

async function fetched(f, d = deployment(f), fetch = transport([f]).fetch) {
  return fetchTwoMibSystem({
    deployment: d,
    configuredCount: f.descriptor.configuredCount,
    baseUrl,
    fetch,
    crypto: webcrypto,
  });
}

function refresh(f, d) {
  f.descriptor.system.sha256 = sha(f.system);
  f.descriptor.bootstrap.sha256 = sha(f.bootstrap);
  f.descriptor.bios.sha256 = sha(f.system.subarray(5632, 6656));
  f.descriptor.residents.ccp.sha256 = sha(f.system.subarray(0, 2048));
  f.descriptor.residents.bdos.sha256 = sha(f.system.subarray(2048, 5632));
  Object.assign(d, deployment(f));
}

for (let count = 1; count <= 16; count++)
  test(`fetches and admits exact profile ${count}`, async () => {
    const f = fixture(count);
    const d = deployment(f);
    const network = transport([f]);
    const result = await fetched(f, d, network.fetch);
    assert.deepEqual(result.system, f.system);
    assert.deepEqual(result.bootstrap, f.bootstrap);
    assert.deepEqual(result.descriptor, f.descriptor);
    assert.equal(network.calls.length, 2);
    assert.equal(
      network.calls[0].url,
      new URL(f.descriptor.system.asset, baseUrl).href,
    );
    assert.deepEqual(network.calls[0].options, {
      cache: "no-store",
      redirect: "error",
    });
    const saved = snapshot(f);
    const before = Uint8Array.from(saved.slots[0].bytes);
    for (const offset of [
      0, 2047, 2048, 5631, 5632, 6655, 6656, 16383, 2097151,
    ]) {
      saved.slots[0].bytes[offset] = 91;
      before[offset] = 91;
    }
    const admitted = await admitTwoMibSavedMachine({
      snapshot: saved,
      deployment: d,
      crypto: webcrypto,
    });
    assert.equal(admitted.status, "admitted");
    assert.deepEqual(admitted.snapshot.slots[0].bytes, before);
    assert.notEqual(
      admitted.snapshot.slots[0].bytes.buffer,
      saved.slots[0].bytes.buffer,
    );
    assert.equal(network.calls.length, 2, "admission has no fetch dependency");
    result.system.fill(255);
    result.descriptor.bios.dpb = 0;
    assert.deepEqual(d, deployment(f), "returned descriptor is detached");
  });

for (const count of [0, 17, 1.5, "2", null, NaN])
  test(`rejects invalid count ${String(count)} before fetch`, async () => {
    let calls = 0;
    await assert.rejects(
      fetchTwoMibSystem({
        configuredCount: count,
        deployment: deployment(fixture(2)),
        baseUrl,
        fetch: () => {
          calls++;
        },
        crypto: webcrypto,
      }),
      { code: "PROFILE_METADATA_INVALID" },
    );
    assert.equal(calls, 0);
  });

const metadataChanges = [
  [
    "count/profile mismatch",
    (d) => {
      d.twoMibProfiles[0].configuredCount = 1;
    },
  ],
  [
    "neighbor profile",
    (d) => {
      d.twoMibProfiles[0].residentProfile = "triptych-cpu-v0.1-2m-n01";
    },
  ],
  [
    "wrong paired lock",
    (d) => {
      d.twoMibProfiles[0].residents.lock =
        "distribution/residents-2m/n01.lock.json";
    },
  ],
  [
    "wrong paired manifest",
    (d) => {
      d.twoMibProfiles[0].residents.manifest =
        d.twoMibProfiles[0].residents.manifest.replace("n02", "n01");
    },
  ],
  [
    "wrong source",
    (d) => {
      d.twoMibProfiles[0].bios.source = "system/cpm/bios-8m.asm";
    },
  ],
  [
    "wrong source hash",
    (d) => {
      d.twoMibProfiles[0].bios.sourceSha256 = "A".repeat(64);
    },
  ],
  [
    "wrong offset",
    (d) => {
      d.twoMibProfiles[0].residents.bdos.offset++;
    },
  ],
  [
    "wrong origin",
    (d) => {
      d.twoMibProfiles[0].layout.ccp++;
    },
  ],
  [
    "wrong count table",
    (d) => {
      d.twoMibProfiles[0].layout.dphEnd -= 16;
    },
  ],
  [
    "wrong common bounds",
    (d) => {
      d.twoMibProfiles[0].bios.dpb = 0;
    },
  ],
  [
    "wrong release",
    (d) => {
      d.twoMibProfiles[0].residents.version = "0.1.3";
    },
  ],
  [
    "wrong dirty type",
    (d) => {
      d.twoMibProfiles[0].machine.dirty = "false";
    },
  ],
  [
    "duplicate profile",
    (d) => {
      d.twoMibProfiles.push(structuredClone(d.twoMibProfiles[0]));
    },
  ],
  [
    "duplicate asset",
    (d) => {
      d.assets.push({ ...d.assets[0] });
    },
  ],
  [
    "missing asset",
    (d) => {
      d.assets.pop();
    },
  ],
  [
    "asset digest mismatch",
    (d) => {
      d.assets[0].sha256 = "0".repeat(64);
    },
  ],
  [
    "traversal",
    (d) => {
      d.twoMibProfiles[0].system.asset = "../escape.bin";
    },
  ],
  [
    "extra nested field",
    (d) => {
      d.twoMibProfiles[0].atom.seed.extra = true;
    },
  ],
  [
    "symbol field",
    (d) => {
      d.twoMibProfiles[0][Symbol("extra")] = true;
    },
  ],
  [
    "sparse array",
    (d) => {
      d.twoMibProfiles.length = 2;
    },
  ],
  [
    "accessor",
    (d) => {
      Object.defineProperty(d.twoMibProfiles[0], "id", {
        get() {
          throw Error("must not execute");
        },
      });
    },
  ],
  [
    "oversized asset metadata",
    (d) => {
      d.assets.length = 4097;
    },
  ],
  [
    "contradictory outer revision",
    (d) => {
      d.distribution = { triptych: { revision: "c".repeat(40) } };
    },
  ],
  [
    "contradictory outer dirty state",
    (d) => {
      d.distribution = { triptych: { dirty: false } };
    },
  ],
];
for (const [label, change] of metadataChanges)
  test(`rejects ${label} before network or hashing`, async () => {
    const f = fixture(2);
    const d = deployment(f);
    change(d);
    const network = transport([f]);
    await assert.rejects(fetched(f, d, network.fetch), {
      code: "PROFILE_METADATA_INVALID",
    });
    await assert.rejects(
      admitTwoMibSavedMachine({
        snapshot: snapshot(f),
        deployment: d,
        crypto: {
          subtle: {
            digest() {
              throw Error("must not hash");
            },
          },
        },
      }),
      { code: "PROFILE_METADATA_INVALID" },
    );
    assert.equal(network.calls.length, 0);
  });

for (const [small, large] of [
  [1, 2],
  [3, 4],
  [15, 16],
])
  test(`rejects paired BIOS substitution ${small}/${large} even with matching hashes`, async () => {
    const a = fixture(small);
    const b = fixture(large);
    assert.deepEqual(a.bootstrap, b.bootstrap);
    assert.deepEqual(a.system.subarray(0, 5632), b.system.subarray(0, 5632));
    for (const [target, donor] of [
      [a, b],
      [b, a],
    ]) {
      const changed = structuredClone(target);
      changed.system.set(donor.system.subarray(5632, 6656), 5632);
      const d = deployment(changed);
      refresh(changed, d);
      await assert.rejects(fetched(changed, d), {
        code: "PROFILE_ASSET_INVALID",
      });
    }
  });

for (const [label, change] of [
  [
    "system tail",
    (f) => {
      f.system[6656] = 1;
    },
  ],
  [
    "DPB",
    (f) => {
      f.system[5632 + 500] ^= 1;
    },
  ],
  [
    "DPH ALV",
    (f) => {
      f.system[5632 + 768 + 14] ^= 1;
    },
  ],
  [
    "common padding",
    (f) => {
      f.system[5632 + 767] = 1;
    },
  ],
  [
    "unused DPH",
    (f) => {
      f.system[5632 + 1023] = 1;
    },
  ],
  [
    "SELDSK count",
    (f) => {
      f.system[5632 + 66] = 1;
    },
  ],
  [
    "bootstrap address",
    (f) => {
      f.bootstrap[24] ^= 1;
    },
  ],
])
  test(`rejects ${label} even when complete and slice digests are recomputed`, async () => {
    const f = fixture(2);
    change(f);
    const d = deployment(f);
    refresh(f, d);
    await assert.rejects(fetched(f, d), { code: "PROFILE_ASSET_INVALID" });
  });

test("captures metadata before network await and saved bytes before hash await, including Buffer views", async () => {
  const f = fixture(2);
  const d = deployment(f);
  const expectedDescriptor = structuredClone(d.twoMibProfiles[0]);
  const network = transport([f], (call) => {
    if (call === 1) {
      d.twoMibProfiles[0].bios.dpb = 0;
      d.assets.length = 0;
    }
  });
  const result = await fetched(f, d, network.fetch);
  assert.deepEqual(result.descriptor, expectedDescriptor);
  const fresh = deployment(f);
  const saved = snapshot(f, true);
  saved.bootstrap.bytes = Buffer.from(f.bootstrap);
  const shared = Buffer.alloc(2097152, 67);
  saved.slots[0].bytes = shared;
  saved.slots[1].bytes = shared.subarray(0);
  const admitted = await admitTwoMibSavedMachine({
    snapshot: saved,
    deployment: fresh,
    crypto: {
      subtle: {
        digest(algorithm, bytes) {
          saved.bootstrap.bytes.fill(0);
          shared.fill(0);
          fresh.twoMibProfiles[0].bootstrap.sha256 = "0".repeat(64);
          return webcrypto.subtle.digest(algorithm, bytes);
        },
      },
    },
  });
  assert.equal(admitted.status, "admitted");
  assert.deepEqual(admitted.snapshot.bootstrap.bytes, f.bootstrap);
  assert.equal(admitted.snapshot.slots[0].bytes[2097151], 67);
  assert.equal(admitted.snapshot.slots[1].bytes[2097151], 67);
  admitted.snapshot.slots[0].bytes[0] = 1;
  assert.equal(admitted.snapshot.slots[1].bytes[0], 67);
});

test("captures one full sixteen-media machine with independent owned buffers", async () => {
  const f = fixture(16);
  const saved = snapshot(f, true);
  const result = await admitTwoMibSavedMachine({
    snapshot: saved,
    deployment: deployment(f),
    crypto: webcrypto,
  });
  assert.equal(result.status, "admitted");
  assert.equal(
    result.snapshot.slots.reduce((sum, slot) => sum + slot.bytes.length, 256),
    33554688,
  );
  for (let drive = 0; drive < 16; drive++) {
    assert.notEqual(
      result.snapshot.slots[drive].bytes.buffer,
      saved.slots[drive].bytes.buffer,
    );
    for (let other = 0; other < drive; other++)
      assert.notEqual(
        result.snapshot.slots[drive].bytes.buffer,
        result.snapshot.slots[other].bytes.buffer,
      );
  }
});

test("accepts matching outer source identity without requiring full distribution metadata", async () => {
  const f = fixture(2);
  const d = deployment(f);
  d.distribution = {
    triptych: { revision: f.descriptor.machine.revision, dirty: true },
  };
  assert.deepEqual((await fetched(f, d)).descriptor, f.descriptor);
  assert.equal(
    (
      await admitTwoMibSavedMachine({
        snapshot: snapshot(f),
        deployment: d,
        crypto: webcrypto,
      })
    ).status,
    "admitted",
  );
});

test("rejects shared-memory saved input before hashing", async () => {
  const f = fixture(1);
  for (const role of ["bootstrap", "disk"]) {
    const saved = snapshot(f);
    if (role === "bootstrap")
      saved.bootstrap.bytes = new Uint8Array(new SharedArrayBuffer(256));
    else saved.slots[0].bytes = new Uint8Array(new SharedArrayBuffer(2097152));
    await assert.rejects(
      admitTwoMibSavedMachine({
        snapshot: saved,
        deployment: deployment(f),
        crypto: {
          subtle: {
            digest() {
              throw Error("must not hash");
            },
          },
        },
      }),
      { code: "SAVED_MACHINE_INVALID" },
    );
  }
});

test("historical, absent and unavailable profiles preserve recovery without fetching", async () => {
  const f = fixture(2);
  for (const d of [
    { schema: "triptych-browser-deployment-v1" },
    deployment(),
    deployment(fixture(1)),
  ]) {
    const saved = snapshot(f);
    const result = await admitTwoMibSavedMachine({
      snapshot: saved,
      deployment: d,
      crypto: webcrypto,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.code, "PROFILE_UNAVAILABLE");
    assert.deepEqual(result.snapshot, saved);
    await assert.rejects(
      fetched(f, d, () => {
        throw Error("must not fetch");
      }),
      { code: "PROFILE_UNAVAILABLE" },
    );
  }
  const saved = snapshot(f);
  saved.bootstrap.bytes[255] = 71;
  const result = await admitTwoMibSavedMachine({
    snapshot: saved,
    deployment: deployment(f),
    crypto: webcrypto,
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.code, "SAVED_BOOTSTRAP_MISMATCH");
  assert.deepEqual(result.snapshot, saved);
});

test("consistent paired relabelling has the documented historical-identity limit", async () => {
  const f = fixture(1);
  const next = fixture(2);
  const saved = snapshot(f);
  saved.slots[0].bytes.set(f.system);
  saved.configuredCount = 2;
  saved.bootstrap.profile = next.descriptor.residentProfile;
  saved.slots.push(null);
  const result = await admitTwoMibSavedMachine({
    snapshot: saved,
    deployment: deployment(next),
    crypto: webcrypto,
  });
  assert.equal(result.status, "admitted");
  assert.deepEqual(
    result.snapshot,
    saved,
    "admission does not claim BIOS history or correct drive count",
  );
});

function fakeStream(chunks, state, throwing = false) {
  return {
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            state.reads++;
            if (throwing) throw Error("stream failure");
            return chunks.length
              ? { done: false, value: chunks.shift() }
              : { done: true };
          },
          cancel() {
            state.cancelled++;
          },
          releaseLock() {
            state.released++;
          },
        };
      },
    },
  };
}

for (const kind of ["system", "bootstrap"]) {
  for (const mode of ["oversized", "truncated", "broken", "shared", "corrupt"])
    test(`${kind} ${mode} response is rejected without unbounded accumulation`, async () => {
      const f = fixture(2);
      const state = { reads: 0, cancelled: 0, released: 0 };
      const good = transport([f]);
      const fetch = async (url, options) => {
        if (!url.endsWith(f.descriptor[kind].asset))
          return good.fetch(url, options);
        const bytes = Uint8Array.from(f[kind]);
        const chunks =
          mode === "oversized"
            ? [bytes, new Uint8Array([1]), new Uint8Array([2])]
            : mode === "truncated"
              ? [bytes.subarray(0, -1)]
              : mode === "shared"
                ? [new Uint8Array(new SharedArrayBuffer(bytes.length))]
                : [bytes];
        if (mode === "corrupt") bytes[0] ^= 1;
        return fakeStream(chunks, state, mode === "broken");
      };
      await assert.rejects(fetched(f, deployment(f), fetch), {
        code:
          mode === "broken"
            ? "PROFILE_ASSET_UNAVAILABLE"
            : "PROFILE_ASSET_INVALID",
      });
      assert.equal(state.released, 1);
      if (mode !== "corrupt") assert.equal(state.cancelled, 1);
      if (mode === "oversized")
        assert.equal(state.reads, 2, "stops at the first excess chunk");
    });
}

test("rejects bad URLs, failed responses and redirects", async () => {
  const f = fixture(1);
  for (const url of [
    "file:///tmp/x",
    "data:text/plain,x",
    "https://user:pass@example.test/x",
    "bad",
  ])
    await assert.rejects(
      fetchTwoMibSystem({
        deployment: deployment(f),
        configuredCount: 1,
        baseUrl: url,
        fetch() {
          throw Error("must not fetch");
        },
        crypto: webcrypto,
      }),
      { code: "PROFILE_METADATA_INVALID" },
    );
  for (const response of [
    { ok: false },
    { ok: true },
    { ok: true, redirected: true },
    {
      ok: true,
      url: "https://other.test/redirect",
      body: {
        getReader() {
          throw Error("must not read");
        },
      },
    },
  ])
    await assert.rejects(
      fetched(f, deployment(f), async () => response),
      { code: "PROFILE_ASSET_UNAVAILABLE" },
    );
  await assert.rejects(
    fetched(f, deployment(f), async () => {
      throw Error("network");
    }),
    { code: "PROFILE_ASSET_UNAVAILABLE" },
  );
});

test("browser module graph has no Node or assembler imports", async () => {
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, "utf8");
    for (const match of source.matchAll(
      /(?:from\s*|import\s*\()(["'])([^"']+)\1/g,
    )) {
      assert.ok(
        match[2].startsWith("./"),
        `unexpected browser import ${match[2]}`,
      );
      await visit(new URL(match[2], url));
    }
    assert.doesNotMatch(source, /\b(?:require\s*\(|process\.|Buffer\.)/);
  }
  await visit(
    new URL(
      "../../crates/triptych-host-wasm/web/two-mib-system.js",
      import.meta.url,
    ),
  );
  assert.equal(visited.size, 2);
});

test(
  "a pending cancellation cannot delay oversized-response rejection",
  { timeout: 2000 },
  async () => {
    const f = fixture(1);
    let cancelled = false;
    await assert.rejects(
      fetched(f, deployment(f), async () => ({
        ok: true,
        body: {
          getReader() {
            return {
              async read() {
                return { done: false, value: new Uint8Array(16385) };
              },
              cancel() {
                cancelled = true;
                return new Promise(() => {});
              },
              releaseLock() {},
            };
          },
        },
      })),
      { code: "PROFILE_ASSET_INVALID" },
    );
    assert.equal(cancelled, true);
  },
);

test("copies stream chunks before the next asynchronous read", async () => {
  const f = fixture(1);
  const chunk = Buffer.from(f.system);
  let read = false;
  const good = transport([f]);
  const result = await fetched(f, deployment(f), async (url, options) => {
    if (!url.endsWith(f.descriptor.system.asset))
      return good.fetch(url, options);
    return {
      ok: true,
      body: {
        getReader() {
          return {
            async read() {
              if (!read) {
                read = true;
                return { done: false, value: chunk };
              }
              chunk.fill(0);
              return { done: true };
            },
            cancel() {},
            releaseLock() {},
          };
        },
      },
    };
  });
  assert.deepEqual(result.system, f.system);
});

test("missing SHA-256 and locked response streams fail without saved writes", async () => {
  const f = fixture(1);
  const saved = snapshot(f);
  const before = structuredClone(saved);
  await assert.rejects(
    admitTwoMibSavedMachine({
      snapshot: saved,
      deployment: deployment(f),
      crypto: null,
    }),
    { code: "PROFILE_HASH_UNAVAILABLE" },
  );
  assert.deepEqual(saved, before);
  await assert.rejects(
    fetched(f, deployment(f), async () => ({
      ok: true,
      body: {
        getReader() {
          throw Error("locked stream");
        },
      },
    })),
    { code: "PROFILE_ASSET_UNAVAILABLE" },
  );
});
