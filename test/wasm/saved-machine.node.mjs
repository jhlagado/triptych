import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import {
  copySavedMachine,
  prepareSavedMachine,
  restoreSavedMachine,
  validateSavedMachineManifest,
  savedMachineReferences,
  encodeSavedMachine,
  decodeSavedMachineArchive,
  sameSavedMachine,
} from "../../crates/triptych-host-wasm/web/saved-machine.js";
import { copyDriveSet } from "../../crates/triptych-host-wasm/web/drive-set.js";

const V4 = "triptych-drive-set-v4";
const id = (number) =>
  `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function legacy(size = 512) {
  return {
    bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256).fill(42) },
    drives: {
      A: { name: "legacy.img", bytes: new Uint8Array(size).fill(7) },
      B: null,
    },
  };
}
function modern(count = 2, same = false) {
  return {
    schema: V4,
    bootstrap: {
      profile: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
      bytes: new Uint8Array(256).fill(42),
    },
    configuredCount: count,
    slots: Array.from({ length: count }, (_, index) => ({
      instanceId: id(index + 1),
      name: `drive-${index}.img`,
      bytes: new Uint8Array(2097152).fill(same ? 7 : index + 7),
    })),
  };
}

test("unchanged v3 archive golden passes dispatch byte for byte", async () => {
  // Captured from the unchanged v3 codec before this dispatcher existed. Fixed
  // metadata and payload order prevent encoder/decoder agreement hiding drift.
  const metadata =
    '{"schema":"triptych-drive-set-v3","bootstrap":{"profile":"legacy-e400","image":{"sha256":"c2927fc2fa9e7d021b12818b814cef6cba9d47c12aba078254f28748826f5964","byteLength":256}},"drives":{"A":{"name":"legacy.img","image":{"sha256":"15933044960fd23a7daaac9ce51355f1f39894d1c3fe6de21b59b28ce2c77e77","byteLength":512}},"B":null}}';
  const golden = Buffer.concat([
    Buffer.from([84, 82, 80, 84, 89, 68, 83, 51, 68, 1, 0, 0]),
    Buffer.from(metadata),
    Buffer.alloc(512, 7),
    Buffer.alloc(256, 42),
  ]);
  assert.equal(golden.length, 1104);
  assert.equal(
    hash(golden),
    "6846b22a936004f82b83ce67adaad46930acfc55cc10d681aedd9d525abe6a36",
  );
  assert.deepEqual(
    await encodeSavedMachine(legacy(), webcrypto),
    new Uint8Array(golden),
  );
  const backing = Buffer.concat([Buffer.alloc(17), golden, Buffer.alloc(23)]);
  assert.deepEqual(
    await decodeSavedMachineArchive(
      backing.subarray(17, 17 + golden.length),
      webcrypto,
    ),
    legacy(),
  );
});

test("legacy snapshot recovery domain and noncopy equality agree with the unchanged codec", () => {
  for (const size of [512, 256512, 2097152, 8388608]) {
    const value = legacy(size);
    value.drives.A.name = "\u0000" + "x".repeat(300);
    assert.deepEqual(copySavedMachine(value), copyDriveSet(value));
    assert(sameSavedMachine(value, copyDriveSet(value)));
  }
  for (const profile of ["triptych-cpu-v0.1-8m-a", "triptych-cpu-v0.1-8m-ab"]) {
    const value = legacy(8388608);
    value.bootstrap.profile = profile;
    if (profile.endsWith("-ab"))
      value.drives.B = {
        name: "B.img",
        bytes: new Uint8Array(8388608).fill(9),
      };
    assert(sameSavedMachine(value, copyDriveSet(value)));
    const changed = copyDriveSet(value);
    (changed.drives.B ?? changed.drives.A).bytes[511]++;
    assert(!sameSavedMachine(value, changed));
  }
  const inherited = Object.assign(
    Object.create({ schema: "not-an-own-schema" }),
    legacy(),
  );
  assert.deepEqual(copySavedMachine(inherited), legacy());
  assert(sameSavedMachine(inherited, legacy()));
  for (const change of [
    (v) => {
      v.bootstrap.profile = "unknown";
    },
    (v) => {
      v.bootstrap.bytes = new Uint8Array(255);
    },
    (v) => {
      v.drives.A.bytes = new Uint8Array(513);
    },
    (v) => {
      v.drives.A.name = "";
    },
    (v) => {
      v.drives.B = v.drives.A;
    },
    (v) => {
      delete v.drives.B;
    },
    (v) => {
      v.drives.C = null;
    },
    (v) => {
      v.drives.A.extra = true;
    },
  ]) {
    const value = legacy();
    change(value);
    assert.throws(() => copyDriveSet(value));
    assert.throws(() => copySavedMachine(value));
    assert.throws(() => sameSavedMachine(value, legacy()));
    assert.throws(() => sameSavedMachine(legacy(), value));
  }
});

test("own unknown schemas reject instead of falling through to legacy", async () => {
  for (const schema of [
    undefined,
    null,
    "triptych-drive-set-v3",
    "triptych-drive-set-v5",
  ]) {
    const value = { ...legacy(), schema };
    for (const run of [
      copySavedMachine,
      prepareSavedMachine,
      encodeSavedMachine,
    ])
      assert.throws(() => run(value, webcrypto), /schema/);
    assert.throws(() => sameSavedMachine(value, legacy()), /schema/);
    assert.throws(
      () => validateSavedMachineManifest({ schema }),
      /manifest|schema/,
    );
    await assert.rejects(
      Promise.resolve().then(() =>
        restoreSavedMachine({ schema }, new Map(), webcrypto),
      ),
    );
  }
});

test("archive dispatch rejects unknown magic and malformed recognized versions without raw fallback", async () => {
  for (const magic of ["TRPTYDS2", "TRPTYDS5", "TRPTYDSX", "NOTADISK"]) {
    const bytes = new Uint8Array(512);
    bytes.set(Buffer.from(magic));
    assert.throws(() => decodeSavedMachineArchive(bytes, webcrypto), /archive/);
  }
  for (const value of [legacy(), modern()]) {
    const encoded = await encodeSavedMachine(value, webcrypto);
    for (const cut of [8, 11, encoded.length - 1])
      await assert.rejects(
        Promise.resolve().then(() =>
          decodeSavedMachineArchive(encoded.slice(0, cut), webcrypto),
        ),
      );
    const corrupt = encoded.slice();
    corrupt[corrupt.length - 1] ^= 1;
    await assert.rejects(
      Promise.resolve().then(() =>
        decodeSavedMachineArchive(corrupt, webcrypto),
      ),
      /hash/,
    );
    const wrongMetadataVersion = encoded.slice();
    wrongMetadataVersion[7] = value.schema ? 51 : 52;
    await assert.rejects(
      Promise.resolve().then(() =>
        decodeSavedMachineArchive(wrongMetadataVersion, webcrypto),
      ),
    );
  }
});

test("v4 dispatch round-trips all slots and deduplicates blobs without aliasing instances", async () => {
  const value = modern(16, true);
  const prepared = await prepareSavedMachine(value, webcrypto);
  assert.equal(prepared.manifest.schema, V4);
  assert.equal(savedMachineReferences(prepared.manifest).length, 2);
  const restored = await restoreSavedMachine(
    prepared.manifest,
    new Map(prepared.blobs.map((blob) => [blob.sha256, blob.bytes])),
    webcrypto,
  );
  assert(sameSavedMachine(restored, value));
  restored.slots[15].bytes[0] = 99;
  assert.equal(restored.slots[0].bytes[0], 7);
  assert(!sameSavedMachine(restored, value));
  const archive = await encodeSavedMachine(value, webcrypto);
  assert(archive.length < 2097152 + 65536);
  const pending = decodeSavedMachineArchive(archive, webcrypto);
  archive.fill(0);
  assert(sameSavedMachine(await pending, value));
});

test("equality and manifest digest include every v4 identity field", async () => {
  const baseline = modern();
  const initial = await prepareSavedMachine(baseline, webcrypto);
  const digests = new Set([initial.digest]);
  for (const change of [
    (v) => {
      v.bootstrap.bytes[255]++;
    },
    (v) => {
      v.slots[1].instanceId = id(3);
    },
    (v) => {
      v.slots[1].name = "renamed.img";
    },
    (v) => {
      v.slots[1].bytes[2097151]++;
    },
    (v) => {
      v.slots[1] = null;
    },
    (v) => {
      v.slots.reverse();
    },
    (v) => {
      v.configuredCount = 3;
      v.bootstrap.profile = "triptych-cpu-v0.1-2m-n03";
      v.slots.push(null);
    },
  ]) {
    const changed = copySavedMachine(baseline);
    change(changed);
    assert(!sameSavedMachine(baseline, changed));
    assert(!sameSavedMachine(changed, baseline));
    digests.add((await prepareSavedMachine(changed, webcrypto)).digest);
  }
  assert.equal(digests.size, 8);
  assert(!sameSavedMachine(baseline, legacy()));
  const invalid = copySavedMachine(baseline);
  invalid.bootstrap.profile = "triptych-cpu-v0.1-2m-n01";
  assert.throws(() => sameSavedMachine(baseline, invalid));
  invalid.bootstrap.profile = baseline.bootstrap.profile;
  invalid.slots[1].instanceId = invalid.slots[0].instanceId;
  assert.throws(() => sameSavedMachine(invalid, baseline));
});

test("equality validates byte views without copying their buffers", () => {
  for (const source of [legacy(), modern()]) {
    const a = copySavedMachine(source),
      b = copySavedMachine(source);
    const disks = a.schema ? a.slots : [a.drives.A];
    for (const disk of disks) {
      const buffer = disk.bytes.buffer;
      Object.defineProperty(buffer, "slice", {
        value() {
          assert.fail("equality copied payload");
        },
      });
      disk.bytes = new DataView(buffer);
    }
    assert(sameSavedMachine(a, b));
  }
});

test("v3 preparation, references and restoration retain their original manifest schema", async () => {
  const source = legacy();
  const pending = prepareSavedMachine(source, webcrypto);
  source.drives.A.bytes.fill(99);
  const prepared = await pending;
  assert.deepEqual(prepared.snapshot, legacy());
  assert.equal(prepared.manifest.schema, "triptych-drive-set-v3");
  const refs = savedMachineReferences(prepared.manifest);
  assert.equal(refs.length, 2);
  assert.deepEqual(
    refs.map((ref) => ref.sha256),
    refs.map((ref) => ref.sha256).sort(),
  );
  const restored = await restoreSavedMachine(
    prepared.manifest,
    new Map(prepared.blobs.map((blob) => [blob.sha256, blob.bytes])),
    webcrypto,
  );
  assert.deepEqual(restored, legacy());
});
