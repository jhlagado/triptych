import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { prepareTwoMibConfiguration } from "../../crates/triptych-host-wasm/web/saved-machine-configuration.js";
import { copySavedMachine } from "../../crates/triptych-host-wasm/web/saved-machine.js";

assert.ok(
  process.env.TRIPTYCH_TWO_MIB_FIXTURES,
  "A captured all-profile build is required",
);
const { CpmDisk } = createRequire(import.meta.url)(
  resolve(
    process.env.TRIPTYCH_WASM_MODULE ?? "dist/wasm/triptych_host_wasm.js",
  ),
);
const fixtures = await Promise.all(
  Array.from({ length: 16 }, async (_, index) => {
    const directory = join(
      process.env.TRIPTYCH_TWO_MIB_FIXTURES,
      `n${String(index + 1).padStart(2, "0")}`,
    );
    return {
      descriptor: JSON.parse(
        await readFile(join(directory, "descriptor.json"), "utf8"),
      ),
      system: new Uint8Array(await readFile(join(directory, "system.bin"))),
      bootstrap: new Uint8Array(
        await readFile(join(directory, "bootstrap.bin")),
      ),
    };
  }),
);
const deployment = {
  schema: "triptych-browser-deployment-v1",
  twoMibProfiles: fixtures.map((value) => value.descriptor),
  assets: fixtures.flatMap(({ descriptor }) =>
    ["system", "bootstrap"].map((kind) => ({
      path: descriptor[kind].asset,
      bytes: descriptor[kind].bytes,
      sha256: descriptor[kind].sha256,
    })),
  ),
};
const assets = new Map(
  fixtures.flatMap((value) =>
    ["system", "bootstrap"].map((kind) => [
      value.descriptor[kind].asset,
      value[kind],
    ]),
  ),
);
const fetchAsset = async (url) =>
  new Response(assets.get(new URL(url).pathname.slice(1)));
function prepare(snapshot, configuredCount, overrides = {}) {
  return prepareTwoMibConfiguration({
    snapshot,
    configuredCount,
    CpmDisk,
    deployment,
    baseUrl: "https://triptych.test/",
    fetch: fetchAsset,
    crypto: webcrypto,
    ...overrides,
  });
}
function diskBytes(create = CpmDisk.create_two_mib, add) {
  const disk = create();
  try {
    add?.(disk);
    return disk.export_candidate();
  } finally {
    disk.free();
  }
}
function saved(count = 4) {
  const bytes = diskBytes(undefined, (disk) =>
    disk.add_import("NOTE.TXT", Uint8Array.of(65, 66)),
  );
  bytes.fill(0x73, 6656, 16384);
  return {
    schema: "triptych-drive-set-v4",
    configuredCount: count,
    bootstrap: {
      profile: fixtures[count - 1].descriptor.residentProfile,
      bytes: fixtures[count - 1].bootstrap.slice(),
    },
    slots: Array.from({ length: count }, (_, index) =>
      index === 0 || index === count - 1
        ? {
            instanceId: `12345678-1234-4123-8123-${String(index + 1).padStart(12, "0")}`,
            name: "same.img",
            bytes: bytes.slice(),
          }
        : null,
    ),
  };
}

for (let count = 1; count <= 16; count++)
  test(`reconfigure to ${count} preserves files, tail, identities and predecessor`, async () => {
    const source = saved(),
      before = copySavedMachine(source);
    const { snapshot, descriptor } = await prepare(source, count);
    assert.deepEqual(source, before);
    assert.equal(snapshot.configuredCount, count);
    assert.equal(
      snapshot.bootstrap.profile,
      fixtures[count - 1].descriptor.residentProfile,
    );
    assert.deepEqual(snapshot.bootstrap.bytes, fixtures[count - 1].bootstrap);
    assert.deepEqual(
      snapshot.slots[0].bytes.subarray(0, 6656),
      fixtures[count - 1].system.subarray(0, 6656),
    );
    assert.deepEqual(
      snapshot.slots[0].bytes.subarray(6656),
      before.slots[0].bytes.subarray(6656),
    );
    assert.equal(snapshot.slots[0].instanceId, before.slots[0].instanceId);
    for (let index = 1; index < count; index++)
      assert.deepEqual(snapshot.slots[index], before.slots[index] ?? null);
    assert.equal(descriptor.configuredCount, count);
    snapshot.slots[0].bytes.fill(0);
    assert.deepEqual(source, before);
    if (count >= 4) assert.deepEqual(snapshot.slots[3], before.slots[3]);
  });

test("input capture precedes network awaits and cannot alias equal media", async () => {
  const source = saved(),
    before = copySavedMachine(source);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = prepare(source, 16, {
    fetch: async (url) => {
      await gate;
      return fetchAsset(url);
    },
  });
  source.slots[0].bytes.fill(99);
  source.slots[3].name = "changed.img";
  release();
  const { snapshot } = await pending;
  assert.deepEqual(
    snapshot.slots[0].bytes.subarray(6656),
    before.slots[0].bytes.subarray(6656),
  );
  assert.deepEqual(snapshot.slots[3], before.slots[3]);
  snapshot.slots[0].bytes.fill(88);
  assert.deepEqual(snapshot.slots[3], before.slots[3]);
});

test("explicit historical A/B migration assigns separate identities and preserves files", async () => {
  const bytes = diskBytes(CpmDisk.create_eight_mib, (disk) =>
    disk.add_import("NOTE.TXT", Uint8Array.of(65, 66)),
  );
  const source = {
    bootstrap: {
      profile: "triptych-cpu-v0.1-8m-ab",
      bytes: new Uint8Array(256),
    },
    drives: {
      A: { name: "same.img", bytes },
      B: { name: "same.img", bytes: bytes.slice() },
    },
  };
  const before = copySavedMachine(source);
  const { snapshot } = await prepare(source, 4);
  assert.deepEqual(source, before);
  assert.notEqual(snapshot.slots[0].instanceId, snapshot.slots[1].instanceId);
  assert.deepEqual(snapshot.slots.slice(2), [null, null]);
  assert(
    snapshot.slots[1].bytes.subarray(0, 16384).every((byte) => byte === 0),
  );
  for (const slot of snapshot.slots.slice(0, 2)) {
    const disk = new CpmDisk(slot.bytes);
    try {
      assert.deepEqual(
        disk.read_file("NOTE.TXT").subarray(0, 2),
        Uint8Array.of(65, 66),
      );
    } finally {
      disk.free();
    }
  }
});

test("non-fitting B rejects the complete migration without changing either source", async () => {
  const source = {
    bootstrap: {
      profile: "triptych-cpu-v0.1-8m-ab",
      bytes: new Uint8Array(256),
    },
    drives: {
      A: { name: "a.img", bytes: diskBytes(CpmDisk.create_eight_mib) },
      B: {
        name: "b.img",
        bytes: diskBytes(CpmDisk.create_eight_mib, (disk) =>
          disk.add_import("BIG.BIN", new Uint8Array(2048001).fill(42)),
        ),
      },
    },
  };
  const before = copySavedMachine(source);
  await assert.rejects(prepare(source, 4));
  assert.deepEqual(source, before);
});

test("same-format reconfiguration preserves malformed guest filesystem for exact recovery", async () => {
  const source = saved();
  source.slots[0].bytes.fill(0x67, 16384);
  const before = copySavedMachine(source);
  const { snapshot } = await prepare(source, 16);
  assert.deepEqual(
    snapshot.slots[0].bytes.subarray(6656),
    before.slots[0].bytes.subarray(6656),
  );
  assert.deepEqual(source, before);
});

test("invalid counts and missing/corrupt tuples do not change the source", async () => {
  const source = saved(),
    before = copySavedMachine(source);
  for (const count of [0, 17, 1.5, "4", NaN])
    await assert.rejects(prepare(source, count));
  await assert.rejects(
    prepare(source, 4, { deployment: { ...deployment, twoMibProfiles: [] } }),
  );
  await assert.rejects(
    prepare(source, 4, {
      fetch: async () => new Response(new Uint8Array(16384)),
    }),
  );
  assert.deepEqual(source, before);
});
