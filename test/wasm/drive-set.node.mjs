import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  copyDriveSet,
  prepareDriveSet,
  restoreDriveSet,
  validateDriveSetManifest,
  encodeDriveSet,
  decodeDriveSet,
} from "../../crates/triptych-host-wasm/web/drive-set.js";

function snapshot({ large = false, b = false, same = false } = {}) {
  return {
    bootstrap: {
      profile: b
        ? "triptych-cpu-v0.1-8m-ab"
        : large
          ? "triptych-cpu-v0.1-8m-a"
          : "legacy-e400",
      bytes: new Uint8Array(256).fill(7),
    },
    drives: {
      A: {
        name: "A.img",
        bytes: new Uint8Array(large || b ? 8388608 : 512).fill(11),
      },
      B: b
        ? { name: "B.img", bytes: new Uint8Array(8388608).fill(same ? 11 : 22) }
        : null,
    },
  };
}

test("preparation snapshots all fields before yielding and checks complete identity", async () => {
  const value = snapshot();
  const pending = prepareDriveSet(value, webcrypto);
  value.drives.A.bytes.fill(99);
  value.drives.A.name = "changed.img";
  value.bootstrap.bytes.fill(99);
  value.bootstrap.profile = "unknown";
  const result = await pending;
  assert.deepEqual(result.snapshot, snapshot());
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  const identities = new Set([result.digest]);
  for (const change of [
    (item) => {
      item.drives.A.name = "renamed.img";
    },
    (item) => {
      item.drives.A.bytes[511]++;
    },
    (item) => {
      item.bootstrap.bytes[255]++;
    },
  ]) {
    const item = snapshot();
    change(item);
    identities.add((await prepareDriveSet(item, webcrypto)).digest);
  }
  assert.equal(identities.size, 4);
});

test("restore verifies independent copies, while identical A/B payloads share one stored blob", async () => {
  const value = snapshot({ b: true, same: true });
  const prepared = await prepareDriveSet(value, webcrypto);
  assert.equal(prepared.blobs.length, 2);
  const images = new Map(
    prepared.blobs.map(({ sha256, bytes }) => [sha256, bytes]),
  );
  const pending = restoreDriveSet(prepared.manifest, images, webcrypto);
  images.get(prepared.manifest.drives.A.image.sha256).fill(80);
  prepared.manifest.drives.A.name = "changed.img";
  const restored = await pending;
  assert.deepEqual(restored, value);
  restored.drives.A.bytes[0] = 90;
  assert.equal(restored.drives.B.bytes[0], 11);
  assert.equal(value.drives.A.bytes[0], 11);
});

test("resident identity is explicit; capacity never infers an A/B profile", async () => {
  const legacyLarge = snapshot({ large: true });
  legacyLarge.bootstrap.profile = "legacy-e400";
  assert.equal(copyDriveSet(legacyLarge).bootstrap.profile, "legacy-e400");
  const invalid = [
    (v) => {
      v.bootstrap.profile = "unknown";
    },
    (v) => {
      v.bootstrap.bytes = new Uint8Array(255);
    },
    (v) => {
      v.bootstrap.profile = "triptych-cpu-v0.1-8m-a";
    },
    (v) => {
      v.drives.B = v.drives.A;
    },
    (v) => {
      delete v.drives.B;
    },
    (v) => {
      v.drives.A.bytes = new Uint8Array(513);
    },
    (v) => {
      v.drives.A.name = "";
    },
    (v) => {
      v.drives.C = v.drives.A;
    },
    (v) => {
      v.drives.A.extra = "unsupported";
    },
  ];
  for (const change of invalid) {
    const value = snapshot();
    change(value);
    assert.throws(() => copyDriveSet(value), /Drive set:/);
  }
  const ab = snapshot({ b: true });
  const withB = (await prepareDriveSet(ab, webcrypto)).digest;
  ab.drives.B = null;
  assert.notEqual((await prepareDriveSet(ab, webcrypto)).digest, withB);
  assert.equal(copyDriveSet(ab).bootstrap.profile, "triptych-cpu-v0.1-8m-ab");
  ab.bootstrap.profile = "triptych-cpu-v0.1-8m-a";
  assert.notEqual((await prepareDriveSet(ab, webcrypto)).digest, withB);
});

test("references reject missing, corrupt and contradictory blob data", async () => {
  const prepared = await prepareDriveSet(snapshot(), webcrypto);
  const images = new Map(
    prepared.blobs.map(({ sha256, bytes }) => [sha256, bytes]),
  );
  await assert.rejects(
    restoreDriveSet(prepared.manifest, new Map(), webcrypto),
    /invalid bytes/,
  );
  images.get(prepared.manifest.drives.A.image.sha256)[0]++;
  await assert.rejects(
    restoreDriveSet(prepared.manifest, images, webcrypto),
    /hash mismatch/,
  );
  images.set(prepared.manifest.drives.A.image.sha256, new Uint8Array(1));
  await assert.rejects(
    restoreDriveSet(prepared.manifest, images, webcrypto),
    /length mismatch/,
  );
  const conflict = structuredClone(prepared.manifest);
  conflict.drives.A.image.sha256 = conflict.bootstrap.image.sha256;
  assert.throws(
    () => validateDriveSetManifest(conflict),
    /conflicting image lengths/,
  );
  const unknown = structuredClone(prepared.manifest);
  unknown.drives.A.image.sha256 = "A".repeat(64);
  assert.throws(
    () => validateDriveSetManifest(unknown),
    /invalid image reference/,
  );
  await assert.rejects(prepareDriveSet(snapshot(), {}), /SHA-256 unavailable/);
});

test("byte views preserve their exact offset; they cannot alias the saved snapshot", () => {
  const value = snapshot();
  const backing = new Uint8Array(1024).fill(33);
  value.drives.A.bytes = new DataView(backing.buffer, 256, 512);
  const result = copyDriveSet(value);
  backing.fill(44);
  assert.deepEqual(result.drives.A.bytes, new Uint8Array(512).fill(33));
});

test("complete-set archives round-trip small, large A, distinct A/B and shared A/B", async () => {
  for (const options of [
    {},
    { large: true },
    { b: true },
    { b: true, same: true },
  ]) {
    const value = snapshot(options);
    const archive = await encodeDriveSet(value, webcrypto);
    assert.deepEqual(await decodeDriveSet(archive, webcrypto), value);
    assert.deepEqual(
      await encodeDriveSet(await decodeDriveSet(archive, webcrypto), webcrypto),
      archive,
    );
    if (options.same) assert.ok(archive.length < 8388608 + 4096);
  }
});

test("archive decoding rejects corruption, truncation, oversized metadata and trailing bytes", async () => {
  const archive = await encodeDriveSet(snapshot(), webcrypto);
  for (const cut of [0, 7, 11, 12, archive.length - 1])
    await assert.rejects(decodeDriveSet(archive.slice(0, cut), webcrypto));
  for (const at of [0, archive.length - 1]) {
    const damaged = archive.slice();
    damaged[at] ^= 1;
    await assert.rejects(decodeDriveSet(damaged, webcrypto));
  }
  const long = new Uint8Array(archive.length + 1);
  long.set(archive);
  await assert.rejects(decodeDriveSet(long, webcrypto), /trailing bytes/);
  for (const length of [0, 1048577, 0xffffffff]) {
    const damaged = archive.slice();
    new DataView(damaged.buffer).setUint32(8, length, true);
    await assert.rejects(decodeDriveSet(damaged, webcrypto), /metadata length/);
  }
});

test("archive bytes are copied before async verification", async () => {
  const archive = await encodeDriveSet(snapshot(), webcrypto);
  const pending = decodeDriveSet(archive, webcrypto);
  archive.fill(0);
  assert.deepEqual(await pending, snapshot());
});

test("archive rejects a UTF-8 BOM rather than silently normalizing metadata", async () => {
  const archive = await encodeDriveSet(snapshot(), webcrypto);
  const noncanonical = new Uint8Array(archive.length + 3);
  noncanonical.set(archive.subarray(0, 12));
  noncanonical.set([0xef, 0xbb, 0xbf], 12);
  noncanonical.set(archive.subarray(12), 15);
  new DataView(noncanonical.buffer).setUint32(
    8,
    new DataView(archive.buffer).getUint32(8, true) + 3,
    true,
  );
  await assert.rejects(decodeDriveSet(noncanonical, webcrypto));
});
