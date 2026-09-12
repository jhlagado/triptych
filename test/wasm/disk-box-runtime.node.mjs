import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { prepareSavedMachineAdoption } from "../../crates/triptych-host-wasm/web/disk-box-adoption.js";
import { resolveDiskBoxConfiguration } from "../../crates/triptych-host-wasm/web/disk-box-runtime.js";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
async function fixture(count = 4) {
  const bytes = Buffer.alloc(2097152, 7);
  const { manifest, newBlobs } = await prepareSavedMachineAdoption(
    {
      schema: "triptych-drive-set-v4",
      configuredCount: count,
      bootstrap: {
        profile: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
        bytes: new Uint8Array(256),
      },
      slots: Array.from({ length: count }, (_, i) =>
        i === 0 ? { instanceId: id(1), name: "System", bytes } : null,
      ),
    },
    { configurationId: id(2), name: "Example", crypto: webcrypto },
  );
  return { manifest, bytes: newBlobs.values().next().value };
}
const resolve = (manifest, readPersonalDisk, fetchImage) =>
  resolveDiskBoxConfiguration({
    manifest,
    configurationId: id(2),
    readPersonalDisk,
    fetchImage,
    crypto: webcrypto,
  });

for (const count of [1, 4, 16])
  test(`resolves ${count} configured slots without filling empty drives`, async () => {
    const { manifest, bytes } = await fixture(count);
    const result = await resolve(manifest, async () => bytes);
    assert.equal(result.slots.length, count);
    assert.equal(result.slots.filter(Boolean).length, 1);
    assert.equal(result.slots[0].writable, true);
    assert.deepEqual(result.slots[0].bytes, bytes);
    result.systemDisk.bytes[0] = 9;
    assert.equal(result.slots[0].bytes[0], 7);
    assert.equal(bytes[0], 7);
  });

test("protected-only configuration never reads personal storage", async () => {
  const { manifest, bytes } = await fixture();
  const disk = manifest.personalDisks[0];
  const binding = {
    kind: "published",
    image: {
      id: "system",
      revision: "v1",
      name: "System",
      geometry: disk.geometry,
      ...disk.content,
      url: "https://example.test/system.img",
      source: "https://example.test/source",
      license: "MIT",
      systemProfile: manifest.configurations[0].bootstrap.profile,
    },
  };
  manifest.personalDisks = [];
  manifest.configurations[0].slots[0] = binding;
  manifest.configurations[0].systemDisk = binding;
  const result = await resolve(
    manifest,
    () => assert.fail("personal storage accessed"),
    async () => bytes,
  );
  assert.equal(result.slots[0].writable, false);
  assert.equal(result.systemDisk.writable, false);
});

test("captured identity rejects changed personal bytes and missing media", async () => {
  const { manifest, bytes } = await fixture();
  await assert.rejects(
    resolve(manifest, async () => bytes.subarray(1)),
    /length/,
  );
  await assert.rejects(
    resolve(manifest, async () => new Uint8Array(bytes.length).fill(8)),
    /changed/,
  );
  await assert.rejects(
    resolve(manifest, async () => {
      throw new Error("unavailable");
    }),
    /unavailable/,
  );
});

test("configuration metadata is captured before asynchronous disk reads", async () => {
  const { manifest, bytes } = await fixture();
  let release;
  const gate = new Promise((r) => (release = r));
  const pending = resolve(manifest, async () => {
    await gate;
    return bytes;
  });
  manifest.configurations[0].bootstrap.bytes[0] = 99;
  manifest.configurations[0].slots[0].writable = false;
  manifest.personalDisks[0].name = "Changed";
  release();
  const result = await pending;
  assert.equal(result.bootstrap.bytes[0], 0);
  assert.equal(result.slots[0].writable, true);
  assert.equal(result.slots[0].name, "System");
});
