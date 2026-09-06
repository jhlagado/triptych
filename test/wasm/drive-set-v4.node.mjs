import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import {
  DRIVE_SET_V4_SCHEMA,
  copyDriveSetV4,
  validateDriveSetSnapshotV4,
  validateDriveSetManifestV4,
  driveSetReferencesV4,
  prepareDriveSetV4,
  restoreDriveSetV4,
  encodeDriveSetV4,
  decodeDriveSetV4,
} from "../../crates/triptych-host-wasm/web/drive-set-v4.js";

const DISK = 2097152;
const MAX_ARCHIVE = 33620236;
const encoder = new TextEncoder();
function snapshot(count = 2, { sparse = false, same = false } = {}) {
  const shared = new Uint8Array(DISK).fill(11);
  return {
    schema: DRIVE_SET_V4_SCHEMA,
    configuredCount: count,
    bootstrap: {
      profile: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
      bytes: new Uint8Array(256).fill(7),
    },
    slots: Array.from({ length: count }, (_, index) =>
      sparse && index % 2 === 1
        ? null
        : {
            instanceId: `550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
            name: `${String.fromCharCode(65 + index)}.img`,
            bytes: same ? shared : new Uint8Array(DISK).fill(index + 11),
          },
    ),
  };
}

function frame(text, payload = new Uint8Array()) {
  const metadata = typeof text === "string" ? encoder.encode(text) : text;
  const result = new Uint8Array(12 + metadata.length + payload.length);
  result.set(encoder.encode("TRPTYDS4"));
  new DataView(result.buffer).setUint32(8, metadata.length, true);
  result.set(metadata, 12);
  result.set(payload, 12 + metadata.length);
  return result;
}

function manifestFixture(count = 2) {
  const value = snapshot(count, { sparse: true });
  return {
    schema: value.schema,
    configuredCount: count,
    bootstrap: {
      profile: value.bootstrap.profile,
      image: { sha256: "f".repeat(64), byteLength: 256 },
    },
    slots: value.slots.map((slot) =>
      slot === null
        ? null
        : {
            instanceId: slot.instanceId,
            name: slot.name,
            image: { sha256: "a".repeat(64), byteLength: DISK },
          },
    ),
  };
}

for (let count = 1; count <= 16; count++) {
  test(`v4 count ${count}: sparse slots retain positions and round-trip canonically`, async () => {
    const value = snapshot(count, { sparse: true, same: true });
    const bytes = await encodeDriveSetV4(value, webcrypto);
    assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), "TRPTYDS4");
    const length = new DataView(bytes.buffer).getUint32(8, true);
    const manifest = JSON.parse(
      new TextDecoder().decode(bytes.subarray(12, 12 + length)),
    );
    assert.deepEqual(Object.keys(manifest), [
      "schema",
      "configuredCount",
      "bootstrap",
      "slots",
    ]);
    assert.equal(bytes.length, 12 + length + 256 + DISK);
    const restored = await decodeDriveSetV4(bytes, webcrypto);
    assert.deepEqual(restored, value);
    assert.deepEqual(await encodeDriveSetV4(restored, webcrypto), bytes);
  });
}

test("sixteen distinct payloads round-trip with ASCII-sorted unique references", async () => {
  const value = snapshot(16);
  const prepared = await prepareDriveSetV4(value, webcrypto);
  const refs = driveSetReferencesV4(prepared.manifest);
  assert.equal(refs.length, 17);
  assert.deepEqual(
    refs.map((ref) => ref.sha256),
    refs.map((ref) => ref.sha256).sort(),
  );
  const bytes = await encodeDriveSetV4(value, webcrypto);
  assert.ok(bytes.length <= MAX_ARCHIVE);
  let offset = 12 + new DataView(bytes.buffer).getUint32(8, true);
  const blobs = new Map(
    prepared.blobs.map(({ sha256, bytes: payload }) => [sha256, payload]),
  );
  for (const ref of refs) {
    assert.deepEqual(
      bytes.subarray(offset, offset + ref.byteLength),
      blobs.get(ref.sha256),
    );
    offset += ref.byteLength;
  }
  assert.equal(offset, bytes.length);
  assert.deepEqual(await decodeDriveSetV4(bytes, webcrypto), value);
});

test("snapshot preparation owns metadata and aliased bytes before first yield", async () => {
  const value = snapshot(2, { same: true });
  const expected = copyDriveSetV4(value);
  const pending = prepareDriveSetV4(value, webcrypto);
  value.slots[0].bytes.fill(99);
  value.slots[1].name = "changed";
  value.slots[0].instanceId = "changed";
  value.bootstrap.bytes.fill(99);
  value.bootstrap.profile = "unknown";
  value.configuredCount = 16;
  const prepared = await pending;
  assert.deepEqual(prepared.snapshot, expected);
  assert.equal(prepared.blobs.length, 2);
  assert.notEqual(
    prepared.snapshot.slots[0].bytes,
    prepared.snapshot.slots[1].bytes,
  );
  prepared.snapshot.slots[0].bytes[0] = 20;
  assert.equal(prepared.snapshot.slots[1].bytes[0], 11);
});

test("restore captures all referenced blobs before yielding and separates identical disks", async () => {
  const value = snapshot(16, { same: true });
  const prepared = await prepareDriveSetV4(value, webcrypto);
  const blobs = new Map(
    prepared.blobs.map(({ sha256, bytes }) => [sha256, bytes]),
  );
  const pending = restoreDriveSetV4(prepared.manifest, blobs, webcrypto);
  for (const bytes of blobs.values()) bytes.fill(99);
  prepared.manifest.slots[0].name = "changed";
  prepared.manifest.slots[0].image.sha256 = "0".repeat(64);
  const restored = await pending;
  assert.deepEqual(restored, value);
  assert.equal(
    new Set(restored.slots.map((slot) => slot.bytes.buffer)).size,
    16,
  );
  restored.slots[0].bytes[0] = 90;
  assert.equal(restored.slots[15].bytes[0], 11);
});

test("decoder captures its archive before yielding, including offset byte views", async () => {
  const value = snapshot(2, { same: true });
  const archive = await encodeDriveSetV4(value, webcrypto);
  const padded = new Uint8Array(archive.length + 10);
  padded.set(archive, 5);
  const pending = decodeDriveSetV4(
    new DataView(padded.buffer, 5, archive.length),
    webcrypto,
  );
  padded.fill(0);
  assert.deepEqual(await pending, value);
});

test("validation is non-copying and accepts exact ArrayBuffer/view byte ranges", () => {
  const value = snapshot(1);
  const diskBuffer = new ArrayBuffer(DISK + 8);
  value.slots[0].bytes = new DataView(diskBuffer, 4, DISK);
  value.bootstrap.bytes = new ArrayBuffer(256);
  const validated = validateDriveSetSnapshotV4(value);
  assert.equal(validated.slots[0].bytes.buffer, diskBuffer);
  assert.equal(validated.slots[0].bytes.byteOffset, 4);
  const copy = copyDriveSetV4(value);
  assert.notEqual(copy.slots[0].bytes.buffer, diskBuffer);
  assert.equal(copy.slots[0].bytes.length, DISK);
});

const invalidSnapshots = [
  [
    "extra root field",
    (v) => {
      v.extra = 1;
    },
  ],
  [
    "symbol root field",
    (v) => {
      v[Symbol("extra")] = 1;
    },
  ],
  [
    "wrong schema",
    (v) => {
      v.schema = "triptych-drive-set-v3";
    },
  ],
  ...[0, 17, 1.5, "2", NaN, Infinity].map((count) => [
    `count ${count}`,
    (v) => {
      v.configuredCount = count;
    },
  ]),
  [
    "profile/count disagreement",
    (v) => {
      v.bootstrap.profile = "triptych-cpu-v0.1-2m-n01";
    },
  ],
  [
    "noncanonical profile",
    (v) => {
      v.bootstrap.profile = "triptych-cpu-v0.1-2m-n2";
    },
  ],
  [
    "unrecognized profile",
    (v) => {
      v.bootstrap.profile = "future-profile";
    },
  ],
  [
    "missing A",
    (v) => {
      v.slots[0] = null;
    },
  ],
  [
    "array hole",
    (v) => {
      delete v.slots[1];
    },
  ],
  [
    "undefined slot",
    (v) => {
      v.slots[1] = undefined;
    },
  ],
  [
    "extra slot",
    (v) => {
      v.slots.push(null);
    },
  ],
  [
    "array custom field",
    (v) => {
      v.slots.extra = 1;
    },
  ],
  [
    "duplicate instance",
    (v) => {
      v.slots[1].instanceId = v.slots[0].instanceId;
    },
  ],
  [
    "uppercase instance",
    (v) => {
      v.slots[0].instanceId = v.slots[0].instanceId.toUpperCase();
    },
  ],
  [
    "wrong UUID version",
    (v) => {
      v.slots[0].instanceId = "550e8400-e29b-11d4-a716-000000000000";
    },
  ],
  [
    "wrong UUID variant",
    (v) => {
      v.slots[0].instanceId = "550e8400-e29b-41d4-7716-000000000000";
    },
  ],
  [
    "empty name",
    (v) => {
      v.slots[0].name = "";
    },
  ],
  [
    "NUL name",
    (v) => {
      v.slots[0].name = "a\0b";
    },
  ],
  [
    "unpaired high surrogate",
    (v) => {
      v.slots[0].name = "\ud800";
    },
  ],
  [
    "unpaired low surrogate",
    (v) => {
      v.slots[0].name = "\udfff";
    },
  ],
  [
    "ASCII name too long",
    (v) => {
      v.slots[0].name = "a".repeat(256);
    },
  ],
  [
    "UTF-8 name too long",
    (v) => {
      v.slots[0].name = "é".repeat(128);
    },
  ],
  [
    "short bootstrap",
    (v) => {
      v.bootstrap.bytes = new Uint8Array(255);
    },
  ],
  [
    "long disk",
    (v) => {
      v.slots[1].bytes = new Uint8Array(DISK + 1);
    },
  ],
  [
    "short disk",
    (v) => {
      v.slots[1].bytes = new Uint8Array(DISK - 1);
    },
  ],
  [
    "not bytes",
    (v) => {
      v.slots[1].bytes = [];
    },
  ],
];
for (const [label, change] of invalidSnapshots) {
  test(`snapshot rejects ${label} before any payload copy`, () => {
    const value = snapshot();
    change(value);
    const slice = Uint8Array.prototype.slice;
    let copies = 0;
    Uint8Array.prototype.slice = function (...args) {
      copies++;
      return slice.apply(this, args);
    };
    try {
      assert.throws(() => copyDriveSetV4(value));
    } finally {
      Uint8Array.prototype.slice = slice;
    }
    assert.equal(copies, 0);
  });
}

test("255 UTF-8 bytes, non-BMP characters and unnormalized names remain exact", () => {
  for (const name of [
    "a".repeat(255),
    "é".repeat(127) + "a",
    "😀",
    "e\u0301",
  ]) {
    const value = snapshot(1);
    value.slots[0].name = name;
    assert.equal(copyDriveSetV4(value).slots[0].name, name);
  }
});

test("manifest validation rejects bad hashes, lengths, fields and duplicate identities", () => {
  for (const change of [
    (v) => {
      v.bootstrap.image.sha256 = "A".repeat(64);
    },
    (v) => {
      v.bootstrap.image.byteLength = 257;
    },
    (v) => {
      v.slots[0].image.byteLength = DISK - 1;
    },
    (v) => {
      v.slots[0].image.extra = true;
    },
    (v) => {
      v.slots[0].image.sha256 = v.bootstrap.image.sha256;
    },
    (v) => {
      v.slots[1] = structuredClone(v.slots[0]);
    },
  ]) {
    const value = manifestFixture();
    change(value);
    assert.throws(() => validateDriveSetManifestV4(value));
    assert.throws(() => driveSetReferencesV4(value));
  }
  const value = manifestFixture(3);
  const result = validateDriveSetManifestV4(value);
  assert.equal(driveSetReferencesV4(result).length, 2);
  value.slots[0].name = "changed";
  assert.equal(result.slots[0].name, "A.img");
});

test("canonical metadata rejects alternate JSON spellings, ordering, duplicate keys and UTF-8 errors", async () => {
  const archive = await encodeDriveSetV4(snapshot(1), webcrypto);
  const length = new DataView(archive.buffer).getUint32(8, true);
  const text = new TextDecoder().decode(archive.subarray(12, 12 + length));
  const manifest = JSON.parse(text);
  const payload = archive.subarray(12 + length);
  assert.deepEqual(
    await decodeDriveSetV4(frame(text, payload), webcrypto),
    snapshot(1),
  );
  const cases = [
    ` ${text}`,
    text.replace('"configuredCount":1', '"configuredCount":1.0'),
    text.replace('"schema":', '"schema":"triptych-drive-set-v4","schema":'),
    text.replace('"A.img"', '"\\u0041.img"'),
    JSON.stringify({
      configuredCount: manifest.configuredCount,
      schema: manifest.schema,
      bootstrap: manifest.bootstrap,
      slots: manifest.slots,
    }),
  ];
  for (const item of cases)
    await assert.rejects(
      decodeDriveSetV4(frame(item, payload), webcrypto),
      /noncanonical archive metadata/,
    );
  await assert.rejects(
    decodeDriveSetV4(frame("\ufeff" + text, payload), webcrypto),
    SyntaxError,
  );
  await assert.rejects(
    decodeDriveSetV4(frame(new Uint8Array([0xff]), payload), webcrypto),
    TypeError,
  );
});

test("archive bounds reject before copying or hashing, including maximum metadata and total limits", async () => {
  const wrongMagic = frame("{}");
  wrongMagic[7] = 51;
  const overMetadata = frame(" ".repeat(65537));
  const truncatedMetadata = frame("{}");
  new DataView(truncatedMetadata.buffer).setUint32(8, 65536, true);
  const atLimit = frame(" ".repeat(65536));
  const zeroMetadata = frame("");
  const payloadMissing = frame(JSON.stringify(manifestFixture(1)));
  for (const bytes of [
    new Uint8Array(MAX_ARCHIVE + 1),
    new Uint8Array(MAX_ARCHIVE),
    new Uint8Array(11),
    wrongMagic,
    overMetadata,
    truncatedMetadata,
    atLimit,
    zeroMetadata,
    payloadMissing,
  ]) {
    const slice = Uint8Array.prototype.slice;
    let copies = 0;
    let hashes = 0;
    Uint8Array.prototype.slice = function (...args) {
      copies++;
      return slice.apply(this, args);
    };
    try {
      await assert.rejects(
        decodeDriveSetV4(bytes, {
          subtle: {
            digest() {
              hashes++;
              throw Error("unexpected hash");
            },
          },
        }),
      );
    } finally {
      Uint8Array.prototype.slice = slice;
    }
    assert.equal(copies, 0);
    assert.equal(hashes, 0);
  }
});

test("truncation, trailing payload and modified payload cannot restore", async () => {
  const archive = await encodeDriveSetV4(snapshot(1), webcrypto);
  await assert.rejects(
    decodeDriveSetV4(archive.subarray(0, -1), webcrypto),
    /payload length/,
  );
  const trailing = new Uint8Array(archive.length + 1);
  trailing.set(archive);
  await assert.rejects(decodeDriveSetV4(trailing, webcrypto), /payload length/);
  archive[archive.length - 1] ^= 1;
  await assert.rejects(decodeDriveSetV4(archive, webcrypto), /hash mismatch/);
});

test("restore rejects missing, wrong-size and corrupted blobs without publishing a snapshot", async () => {
  const prepared = await prepareDriveSetV4(snapshot(1), webcrypto);
  const images = () =>
    new Map(prepared.blobs.map(({ sha256, bytes }) => [sha256, bytes.slice()]));
  const key = prepared.manifest.slots[0].image.sha256;
  const missing = images();
  missing.delete(key);
  await assert.rejects(
    restoreDriveSetV4(prepared.manifest, missing, webcrypto),
  );
  const short = images();
  short.set(key, new Uint8Array(DISK - 1));
  await assert.rejects(
    restoreDriveSetV4(prepared.manifest, short, webcrypto),
    /length mismatch/,
  );
  const bad = images();
  bad.get(key)[0] ^= 1;
  await assert.rejects(
    restoreDriveSetV4(prepared.manifest, bad, webcrypto),
    /hash mismatch/,
  );
  await assert.rejects(
    restoreDriveSetV4(prepared.manifest, {}, webcrypto),
    /collection/,
  );
});

test("preparation detects a SHA-256 provider collision rather than dropping media", async () => {
  await assert.rejects(
    prepareDriveSetV4(snapshot(1), {
      subtle: {
        async digest() {
          return new ArrayBuffer(32);
        },
      },
    }),
    /hash collision/,
  );
});

test("equal-length different disk payloads cannot silently share a collided hash", async () => {
  let diskHashes = 0;
  const crypto = {
    subtle: {
      async digest(algorithm, bytes) {
        if (bytes.length !== DISK)
          return webcrypto.subtle.digest(algorithm, bytes);
        diskHashes++;
        return new ArrayBuffer(32);
      },
    },
  };
  await assert.rejects(
    prepareDriveSetV4(snapshot(2), crypto),
    /image hash collision/,
  );
  assert.equal(diskHashes, 2);
});

test("codec-owned copying is one snapshot, or one archive plus independent outputs", async () => {
  const value = snapshot(16, { same: true });
  const archive = await encodeDriveSetV4(value, webcrypto);
  const prepared = await prepareDriveSetV4(value, webcrypto);
  const blobs = new Map(
    prepared.blobs.map(({ sha256, bytes }) => [sha256, bytes]),
  );
  const measure = async (operation) => {
    const slice = Uint8Array.prototype.slice;
    const lengths = [];
    Uint8Array.prototype.slice = function (...args) {
      const result = slice.apply(this, args);
      lengths.push(result.length);
      return result;
    };
    try {
      await operation();
    } finally {
      Uint8Array.prototype.slice = slice;
    }
    return lengths;
  };
  const expected = 256 + 16 * DISK;
  const preparation = await measure(() => prepareDriveSetV4(value, webcrypto));
  assert.equal(
    preparation.reduce((sum, n) => sum + n, 0),
    expected,
  );
  const restored = await measure(() =>
    restoreDriveSetV4(prepared.manifest, blobs, webcrypto),
  );
  assert.equal(
    restored.reduce((sum, n) => sum + n, 0),
    expected,
  );
  const decoded = await measure(() => decodeDriveSetV4(archive, webcrypto));
  assert.equal(decoded[0], archive.length);
  assert.equal(
    decoded.reduce((sum, n) => sum + n, 0),
    archive.length + expected,
  );
});

test("whole-machine digest includes slot identity, names, count and every media byte", async () => {
  const base = snapshot(2, { sparse: true });
  const digests = new Set([(await prepareDriveSetV4(base, webcrypto)).digest]);
  for (const change of [
    (v) => {
      v.slots[0].instanceId = "550e8400-e29b-41d4-a716-999999999999";
    },
    (v) => {
      v.slots[0].name = "new.img";
    },
    (v) => {
      v.slots[0].bytes[DISK - 1] ^= 1;
    },
    (v) => {
      v.bootstrap.bytes[255] ^= 1;
    },
    (v) => {
      v.configuredCount = 1;
      v.slots.pop();
      v.bootstrap.profile = "triptych-cpu-v0.1-2m-n01";
    },
  ]) {
    const value = copyDriveSetV4(base);
    change(value);
    digests.add((await prepareDriveSetV4(value, webcrypto)).digest);
  }
  assert.equal(digests.size, 6);
});
