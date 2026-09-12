import assert from "node:assert/strict";
import test from "node:test";
import { webcrypto, createHash } from "node:crypto";
import {
  emptyDiskBox,
  prepareDiskBox,
} from "../../crates/triptych-host-wasm/web/disk-box.js";
import {
  canonicalLaunchRecipeDescriptor,
  launchRecipeDigest,
  publicLaunchRecipeReference,
  prepareDiskLaunch,
} from "../../crates/triptych-host-wasm/web/disk-launch.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function ids(start = 0) {
  let next = start;
  return () => id(++next);
}
async function recipe(count = 4, withRoles = true) {
  const bootstrapBytes = Buffer.alloc(256, 33),
    bytes = Buffer.alloc(2097152, 0);
  const profile = `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`;
  const image = {
    id: "system",
    revision: "v1",
    name: "System",
    geometry: "triptych-cpm-2m-v1",
    byteLength: 2097152,
    sha256: "a".repeat(64),
    source: "https://example.test/source",
    license: "MIT",
    systemProfile: profile,
    url: "https://example.test/system.img",
  };
  const seedBytes = new Map();
  const slots = Array.from({ length: count }, (_, i) => {
    if (i === 0 || i === 2)
      return {
        kind: "published",
        image: {
          ...image,
          ...(i === 2 ? { id: "games", systemProfile: null } : {}),
        },
      };
    if (!withRoles) return null;
    const role = i === 1 ? "work" : `saves-${i}`;
    seedBytes.set(role, bytes);
    return {
      kind: "writable-role",
      role,
      name: "My disk",
      geometry: image.geometry,
      seed: {
        sha256: hash(bytes),
        byteLength: bytes.length,
        systemProfile: null,
      },
    };
  });
  const descriptor = {
    schema: "triptych-launch-recipe-v1",
    id: "starter",
    revision: "v1",
    name: "Starter",
    configuredCount: count,
    bootstrap: { profile, sha256: hash(bootstrapBytes), byteLength: 256 },
    slots,
  };
  return {
    descriptor,
    digest: await launchRecipeDigest(descriptor),
    bootstrapBytes,
    seedBytes,
  };
}
const prepare = (current, value, options = {}) =>
  prepareDiskLaunch(current, value, {
    crypto: webcrypto,
    createId: ids(),
    ...options,
  });

for (const count of [1, 4, 16])
  test(`fresh ${count}-slot launch retains independent roles and exact bootstrap`, async () => {
    const value = await recipe(count);
    const before = emptyDiskBox();
    const result = await prepare(before, value);
    assert.deepEqual(before, emptyDiskBox());
    assert.equal(result.reused, false);
    const config = result.manifest.configurations[0];
    assert.equal(result.configurationId, config.id);
    assert.equal(config.configuredCount, count);
    assert.deepEqual(config.bootstrap.bytes, Array.from(value.bootstrapBytes));
    assert.deepEqual(config.systemDisk, config.slots[0]);
    const disks = result.manifest.personalDisks;
    assert.equal(disks.length, value.seedBytes.size);
    assert.equal(new Set(disks.map((disk) => disk.id)).size, disks.length);
    assert.equal(
      result.newBlobs.size,
      disks.length ? 1 : 0,
      "equal seeds do not merge disk identities",
    );
    assert.equal(result.manifest.launchInstances[0].roles.length, disks.length);
    await prepareDiskBox(result.manifest, result.newBlobs);
  });

test("revisit selects retained configuration without seeds, UUIDs, or reseeding written content", async () => {
  const value = await recipe();
  const first = await prepare(emptyDiskBox(), value);
  const second = await prepare(first.manifest, value, {
    freshInstance: true,
    createId: ids(20),
  });
  // Select the first instance again through the persisted lookup, while another
  // configuration is active. Change saved content to represent prior writes.
  second.manifest.recipeSelections[0].instanceId =
    first.manifest.launchInstances[0].id;
  second.manifest.personalDisks[0].content.sha256 = "b".repeat(64);
  const before = structuredClone(second.manifest);
  const result = await prepare(
    second.manifest,
    { descriptor: value.descriptor, digest: value.digest },
    { createId: () => assert.fail("revisit generated ID") },
  );
  assert.equal(result.reused, true);
  assert.equal(result.configurationId, first.configurationId);
  assert.equal(result.manifest.selectedConfigurationId, first.configurationId);
  assert.equal(result.newBlobs.size, 0);
  assert.deepEqual(result.manifest.personalDisks, before.personalDisks);
  assert.deepEqual(result.manifest.configurations, before.configurations);
  assert.deepEqual(second.manifest, before, "input remains untouched");
});

test("fresh instance and new recipe revision preserve all earlier disks/configurations", async () => {
  const value = await recipe();
  const first = await prepare(emptyDiskBox(), value);
  first.manifest.configurations[0].slots[1] = null;
  // A personal disk remains in the box after ejection and independent launch.
  const second = await prepare(first.manifest, value, {
    freshInstance: true,
    createId: ids(20),
  });
  assert.equal(second.manifest.launchInstances.length, 2);
  assert.equal(second.manifest.recipeSelections.length, 1);
  assert.equal(
    second.manifest.recipeSelections[0].instanceId,
    second.manifest.launchInstances[1].id,
  );
  assert.deepEqual(
    second.manifest.personalDisks.slice(0, 2),
    first.manifest.personalDisks,
  );
  assert.deepEqual(
    second.manifest.configurations[0],
    first.manifest.configurations[0],
  );
  const changed = await recipe();
  changed.descriptor.revision = "v2";
  changed.digest = await launchRecipeDigest(changed.descriptor);
  const third = await prepare(second.manifest, changed, { createId: ids(40) });
  assert.equal(third.manifest.recipeSelections.length, 2);
  assert.deepEqual(
    third.manifest.personalDisks.slice(0, 4),
    second.manifest.personalDisks,
  );
});

test("protected-only launch creates no personal blobs; omitted count canonically means four", async () => {
  const value = await recipe(4, false);
  delete value.descriptor.configuredCount;
  assert.equal(await launchRecipeDigest(value.descriptor), value.digest);
  const result = await prepare(emptyDiskBox(), value);
  assert.equal(result.manifest.configurations[0].configuredCount, 4);
  assert.deepEqual(result.manifest.personalDisks, []);
  assert.equal(result.newBlobs.size, 0);
  assert.deepEqual(publicLaunchRecipeReference(value.descriptor), {
    id: "starter",
    revision: "v1",
  });
});

test("canonical metadata, seed Buffer and bootstrap Buffer are owned before awaits", async () => {
  const value = await recipe();
  const pending = prepare(emptyDiskBox(), value);
  value.descriptor.name = "Changed";
  value.descriptor.slots[1].name = "Changed";
  value.bootstrapBytes.fill(99);
  for (const bytes of value.seedBytes.values()) bytes.fill(99);
  const result = await pending;
  assert.equal(result.manifest.configurations[0].name, "Starter");
  assert.equal(result.manifest.personalDisks[0].name, "My disk");
  assert.ok(
    result.manifest.configurations[0].bootstrap.bytes.every(
      (byte) => byte === 33,
    ),
  );
  assert.ok([...result.newBlobs.values()][0].every((byte) => byte === 0));
});

test("registry digest helper captures metadata before await", async () => {
  const value = await recipe();
  const pending = launchRecipeDigest(value.descriptor);
  value.descriptor.slots[0].image.name = "Changed";
  assert.equal(await pending, value.digest);
});

test("mismatched descriptor, bootstrap and seeds reject without UUIDs or input mutation", async () => {
  for (const damage of ["descriptor", "bootstrap", "seed"]) {
    const value = await recipe();
    if (damage === "descriptor") value.descriptor.revision = "forged";
    if (damage === "bootstrap") value.bootstrapBytes[0]++;
    if (damage === "seed") value.seedBytes.get("work")[0]++;
    const current = emptyDiskBox();
    await assert.rejects(
      prepare(current, value, {
        createId: () => assert.fail("invalid input generated ID"),
      }),
      /digest mismatch|hash mismatch/,
    );
    assert.deepEqual(current, emptyDiskBox());
  }
});

test("revisit verifies descriptor digest even when prior selected instance exists", async () => {
  const value = await recipe();
  const first = await prepare(emptyDiskBox(), value);
  value.descriptor.slots[1].role = "changed";
  await assert.rejects(
    prepare(first.manifest, {
      descriptor: value.descriptor,
      digest: value.digest,
    }),
    /recipe digest mismatch/,
  );
});

test("strict counts, roles, names, slot arrays and system profile reject", async () => {
  const value = await recipe();
  const mutations = [
    (d) => {
      d.configuredCount = null;
    },
    (d) => {
      d.configuredCount = 0;
    },
    (d) => {
      d.configuredCount = 17;
    },
    (d) => {
      d.configuredCount = 4.5;
    },
    (d) => {
      d.slots[3].role = "work";
    },
    (d) => {
      d.slots[1].role = "BAD ROLE";
    },
    (d) => {
      d.name = "bad\nname";
    },
    (d) => {
      delete d.slots[2];
    },
    (d) => {
      d.slots[0] = null;
    },
    (d) => {
      d.slots[0].image.systemProfile = null;
    },
    (d) => {
      d.bootstrap.profile = "triptych-cpu-v0.1-2m-n02";
    },
    (d) => {
      d.privateDiskId = id(1);
    },
  ];
  for (const mutate of mutations) {
    const descriptor = structuredClone(value.descriptor);
    mutate(descriptor);
    assert.throws(() => canonicalLaunchRecipeDescriptor(descriptor));
  }
});

test("writable system template retains original A as recovery binding", async () => {
  const value = await recipe(1, false);
  const bytes = new Uint8Array(2097152);
  value.descriptor.slots[0] = {
    kind: "writable-role",
    role: "system",
    name: "Personal system",
    geometry: "triptych-cpm-2m-v1",
    seed: {
      sha256: hash(bytes),
      byteLength: bytes.length,
      systemProfile: value.descriptor.bootstrap.profile,
    },
  };
  value.seedBytes.set("system", bytes);
  value.digest = await launchRecipeDigest(value.descriptor);
  const result = await prepare(emptyDiskBox(), value);
  assert.deepEqual(
    result.manifest.configurations[0].systemDisk,
    result.manifest.configurations[0].slots[0],
  );
  assert.equal(result.manifest.configurations[0].systemDisk.kind, "personal");
});

test("descriptor accessors and nonboolean fresh requests are rejected", async () => {
  const value = await recipe();
  let called = 0;
  Object.defineProperty(value.descriptor, "name", {
    get() {
      called++;
      return "Hidden";
    },
  });
  assert.throws(
    () => canonicalLaunchRecipeDescriptor(value.descriptor),
    /accessors/,
  );
  assert.equal(called, 0);
  await assert.rejects(
    prepare(emptyDiskBox(), await recipe(), { freshInstance: "yes" }),
    /boolean/,
  );
});
