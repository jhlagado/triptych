import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import { prepareSavedMachineAdoption } from "../../crates/triptych-host-wasm/web/disk-box-adoption.js";
import { prepareDiskBox } from "../../crates/triptych-host-wasm/web/disk-box.js";
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const options = {
  configurationId: id(99),
  name: "Preserved machine",
  crypto: webcrypto,
};
const small = (size = 256512) => ({
  bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256).fill(42) },
  drives: {
    A: { name: "Old A", bytes: new Uint8Array(size).fill(7) },
    B: null,
  },
});
const v4 = (count) => ({
  schema: "triptych-drive-set-v4",
  configuredCount: count,
  bootstrap: {
    profile: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
    bytes: new Uint8Array(256).fill(31),
  },
  slots: Array.from({ length: count }, (_, i) =>
    i % 3 === 1
      ? null
      : {
          instanceId: id(i + 1),
          name: `Disk ${i}`,
          bytes: new Uint8Array(2097152).fill(12),
        },
  ),
});

for (const count of [1, 4, 16])
  test(`v4 ${count} preserves slots, UUIDs, access and byte-identical independent disks`, async () => {
    const input = v4(count),
      slotWritable = Array.from({ length: count }, (_, i) => i % 2 === 0);
    const result = await prepareSavedMachineAdoption(input, {
      ...options,
      slotWritable,
      createDiskId: () => assert.fail("v4 must preserve identities"),
    });
    const config = result.manifest.configurations[0];
    assert.equal(config.configuredCount, count);
    assert.equal(config.bootstrap.profile, input.bootstrap.profile);
    assert.deepEqual(config.bootstrap.bytes, Array.from(input.bootstrap.bytes));
    for (const [index, slot] of input.slots.entries()) {
      assert.deepEqual(
        config.slots[index],
        slot === null
          ? null
          : {
              kind: "personal",
              diskId: slot.instanceId,
              writable: slotWritable[index],
            },
      );
    }
    assert.deepEqual(config.systemDisk, config.slots[0]);
    assert.equal(
      new Set(result.manifest.personalDisks.map((disk) => disk.id)).size,
      input.slots.filter(Boolean).length,
    );
    assert.equal(result.newBlobs.size, 1);
    assert.deepEqual([...result.newBlobs.values()][0], input.slots[0].bytes);
    await prepareDiskBox(result.manifest, result.newBlobs, webcrypto);
  });

for (const profile of [
  "legacy-e400",
  "triptych-cpu-v0.1-8m-a",
  "triptych-cpu-v0.1-8m-ab",
])
  test(`legacy ${profile} adopts exact geometry and configured count`, async () => {
    const input = small(profile === "legacy-e400" ? 256512 : 8388608);
    input.bootstrap.profile = profile;
    if (profile.endsWith("-ab"))
      input.drives.B = { name: "Old B", bytes: input.drives.A.bytes };
    let ids = 0;
    const pending = prepareSavedMachineAdoption(input, {
      ...options,
      createDiskId: () => id(++ids),
    });
    assert.equal(
      ids,
      profile.endsWith("-ab") ? 2 : 1,
      "all identities created before first await",
    );
    const result = await pending;
    assert.equal(ids, result.manifest.personalDisks.length);
    const config = result.manifest.configurations[0];
    assert.equal(config.configuredCount, profile.endsWith("-ab") ? 2 : 1);
    if (profile === "legacy-e400") assert.equal(config.slots.length, 1);
    assert.equal(config.bootstrap.profile, profile);
    assert.equal(
      result.manifest.personalDisks[0].geometry,
      profile === "legacy-e400" ? "ibm3740" : "triptych-cpm-8m-v1",
    );
    assert.deepEqual([...result.newBlobs.values()][0], input.drives.A.bytes);
    await prepareDiskBox(result.manifest, result.newBlobs, webcrypto);
  });

test("captures Buffer bytes, bootstrap, names and policy before hashing yields", async () => {
  const input = v4(1);
  input.slots[0].bytes = Buffer.alloc(2097152, 66);
  input.bootstrap.bytes = Buffer.alloc(256, 33);
  const policy = [false];
  const pending = prepareSavedMachineAdoption(input, {
    ...options,
    slotWritable: policy,
  });
  input.slots[0].bytes.fill(99);
  input.bootstrap.bytes.fill(99);
  input.slots[0].name = "Changed";
  input.slots[0].instanceId = id(88);
  policy[0] = true;
  const result = await pending;
  assert.ok([...result.newBlobs.values()][0].every((byte) => byte === 66));
  assert.ok(
    result.manifest.configurations[0].bootstrap.bytes.every(
      (byte) => byte === 33,
    ),
  );
  assert.equal(result.manifest.personalDisks[0].name, "Disk 0");
  assert.deepEqual(result.manifest.configurations[0].systemDisk, {
    kind: "personal",
    diskId: id(1),
    writable: false,
  });
});

test("legacy arbitrary aligned sizes and profile/geometry mismatches require recovery", async () => {
  for (const bytes of [512, 256000, 2097152, 8388608])
    await assert.rejects(
      prepareSavedMachineAdoption(small(bytes), {
        ...options,
        createDiskId: () => id(1),
      }),
      /recovery|geometry/,
    );
  const bad = v4(1);
  bad.slots[0].bytes = new Uint8Array(512);
  await assert.rejects(prepareSavedMachineAdoption(bad, options), /2097152/);
});

test("missing A reports explicit system selection; malformed metadata and access reject", async () => {
  const absent = v4(4);
  absent.slots[0] = null;
  await assert.rejects(prepareSavedMachineAdoption(absent, options), {
    code: "SYSTEM_DISK_SELECTION_REQUIRED",
  });
  for (const slotWritable of [[], [true], [true, false, true, 1], new Array(4)])
    await assert.rejects(
      prepareSavedMachineAdoption(v4(4), { ...options, slotWritable }),
      /dense boolean/,
    );
  await assert.rejects(
    prepareSavedMachineAdoption(v4(1), { ...options, name: "bad\nname" }),
    /display name/,
  );
});

test("accessors are rejected without running caller code", async () => {
  const input = v4(1);
  let calls = 0;
  Object.defineProperty(input.slots[0], "bytes", {
    get() {
      calls++;
      return new Uint8Array(2097152);
    },
  });
  await assert.rejects(prepareSavedMachineAdoption(input, options), /accessor/);
  assert.equal(calls, 0);
});
