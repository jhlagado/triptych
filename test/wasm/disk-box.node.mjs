import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto } from "node:crypto";
import {
  emptyDiskBox,
  validateDiskBoxManifest,
  diskBoxReferences,
  prepareDiskBox,
  mountDiskBoxSlot,
} from "../../crates/triptych-host-wasm/web/disk-box.js";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const hash = "a".repeat(64);
const disk = (n) => ({
  id: id(n),
  name: `Disk ${n}`,
  geometry: "triptych-cpm-2m-v1",
  content: { sha256: hash, byteLength: 2097152 },
});
const personal = (n) => ({ kind: "personal", diskId: id(n), writable: true });
const image = {
  id: "system",
  revision: "v1",
  name: "System",
  geometry: "triptych-cpm-2m-v1",
  byteLength: 2097152,
  sha256: hash,
  url: "https://example.test/system.img",
  source: "https://example.test/source",
  license: "MIT",
  systemProfile: "triptych-cpu-v0.1-2m-n02",
};
const published = { kind: "published", image };
function fixture() {
  return {
    ...emptyDiskBox(),
    personalDisks: [disk(2), disk(3)],
    configurations: [
      {
        id: id(1),
        name: "Work",
        configuredCount: 2,
        bootstrap: {
          profile: "triptych-cpu-v0.1-2m-n02",
          bytes: Array(256).fill(0),
        },
        systemDisk: structuredClone(published),
        slots: [structuredClone(published), personal(2)],
      },
    ],
    selectedConfigurationId: id(1),
  };
}

test("empty and populated disk boxes own validated metadata without media copies", () => {
  assert.deepEqual(validateDiskBoxManifest(emptyDiskBox()), emptyDiskBox());
  const input = fixture();
  const value = validateDiskBoxManifest(input);
  assert.deepEqual(value, input);
  input.personalDisks[0].name = "changed";
  input.configurations[0].bootstrap.bytes[0] = 99;
  input.configurations[0].slots[0].image.name = "changed";
  assert.equal(value.personalDisks[0].name, "Disk 2");
  assert.equal(value.configurations[0].bootstrap.bytes[0], 0);
  assert.equal(value.configurations[0].slots[0].image.name, "System");
});

test("every personal disk is a content root even when ejected; published-only owns no blobs", () => {
  const value = fixture();
  value.personalDisks[1].content.sha256 = "b".repeat(64);
  assert.equal(diskBoxReferences(value).size, 2);
  const ejected = mountDiskBoxSlot(value, id(1), 1, null);
  assert.deepEqual(ejected.personalDisks, value.personalDisks);
  assert.equal(diskBoxReferences(ejected).size, 2);
  const readonly = fixture();
  readonly.personalDisks = [];
  readonly.configurations[0].slots[1] = null;
  assert.equal(diskBoxReferences(readonly).size, 0);
});

test("equal bytes remain separate identities and slots cannot alias one personal disk", () => {
  const value = fixture();
  assert.equal(diskBoxReferences(value).size, 1);
  assert.equal(validateDiskBoxManifest(value).personalDisks.length, 2);
  assert.throws(() => mountDiskBoxSlot(value, id(1), 0, personal(2)), /alias/);
  const moved = mountDiskBoxSlot(
    mountDiskBoxSlot(value, id(1), 1, null),
    id(1),
    0,
    personal(2),
  );
  assert.equal(moved.configurations[0].slots[0].diskId, id(2));
  assert.equal(value.configurations[0].slots[1].diskId, id(2));
});

test("launch selections reference one existing matching instance and preserve role identity", () => {
  const value = fixture();
  value.launchInstances = [
    {
      id: id(4),
      recipeDigest: hash,
      configurationId: id(1),
      roles: [{ role: "work", diskId: id(2) }],
    },
  ];
  value.recipeSelections = [{ recipeDigest: hash, instanceId: id(4) }];
  assert.deepEqual(validateDiskBoxManifest(value), value);
  const invalid = structuredClone(value);
  invalid.recipeSelections[0].recipeDigest = "b".repeat(64);
  assert.throws(() => validateDiskBoxManifest(invalid), /recipe/);
  invalid.recipeSelections = value.recipeSelections;
  invalid.launchInstances[0].roles[0].diskId = id(99);
  assert.throws(() => validateDiskBoxManifest(invalid), /disk/);
});

for (const [name, change] of [
  [
    "unknown field",
    (v) => {
      v.surprise = true;
    },
  ],
  [
    "missing disk",
    (v) => {
      v.personalDisks = [];
    },
  ],
  [
    "duplicate disk",
    (v) => {
      v.personalDisks.push(v.personalDisks[0]);
    },
  ],
  [
    "wrong image length",
    (v) => {
      v.personalDisks[0].content.byteLength = 512;
    },
  ],
  [
    "mismatched profile",
    (v) => {
      v.configurations[0].configuredCount = 4;
    },
  ],
  [
    "missing selection",
    (v) => {
      v.selectedConfigurationId = id(99);
    },
  ],
  [
    "sparse slots",
    (v) => {
      delete v.configurations[0].slots[1];
    },
  ],
  [
    "extra array field",
    (v) => {
      v.personalDisks.other = true;
    },
  ],
  [
    "non-byte bootstrap",
    (v) => {
      v.configurations[0].bootstrap.bytes[0] = 256;
    },
  ],
])
  test(`rejects ${name} without modifying input`, () => {
    const value = fixture();
    change(value);
    const before = structuredClone(value);
    assert.throws(() => validateDiskBoxManifest(value));
    assert.deepEqual(value, before);
  });

for (const allocation of [Uint8Array, Buffer])
  test(`preparation owns ${allocation.name} before awaiting and verifies hashes`, async () => {
    const value = fixture();
    const bytes =
      allocation === Buffer
        ? Buffer.alloc(2097152, 5)
        : new Uint8Array(2097152).fill(5);
    const digest = Buffer.from(
      await webcrypto.subtle.digest("SHA-256", bytes),
    ).toString("hex");
    value.personalDisks.forEach((item) => {
      item.content.sha256 = digest;
    });
    const pending = prepareDiskBox(
      value,
      new Map([[digest, bytes]]),
      webcrypto,
    );
    bytes.fill(9);
    value.personalDisks[0].name = "changed";
    const result = await pending;
    assert.equal(result.manifest.personalDisks[0].name, "Disk 2");
    assert.equal(result.blobs[0].bytes[0], 5);
    assert.equal(result.blobs.length, 1);
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    await assert.rejects(
      prepareDiskBox(result.manifest, new Map([[digest, bytes]]), webcrypto),
      /hash/,
    );
    await assert.rejects(
      prepareDiskBox(emptyDiskBox(), new Map([[digest, bytes]]), webcrypto),
      /unreferenced/,
    );
    // Existing referenced blobs may be resolved by the store rather than supplied again.
    assert.equal(
      (await prepareDiskBox(result.manifest, new Map(), webcrypto)).blobs
        .length,
      0,
    );
  });

test("metadata accessors are rejected without invocation", () => {
  for (const target of ["profile", "array"]) {
    const value = fixture();
    let reads = 0;
    const object =
      target === "profile"
        ? value.configurations[0].bootstrap
        : value.configurations;
    Object.defineProperty(object, target === "profile" ? "profile" : "0", {
      enumerable: true,
      get() {
        reads++;
        return "CORRUPT";
      },
    });
    assert.throws(() => validateDiskBoxManifest(value), /invalid/);
    assert.equal(reads, 0);
  }
});

test("inherited array methods cannot change captured metadata", () => {
  const value = fixture();
  const expected = structuredClone(value);
  const prototype = Object.create(Array.prototype);
  prototype.map = () => {
    throw new Error("untrusted map invoked");
  };
  prototype.slice = () => {
    throw new Error("untrusted slice invoked");
  };
  Object.setPrototypeOf(value.configurations, prototype);
  Object.setPrototypeOf(value.configurations[0].bootstrap.bytes, prototype);
  assert.deepEqual(validateDiskBoxManifest(value), expected);
});
