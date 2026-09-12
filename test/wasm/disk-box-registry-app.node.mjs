import assert from "node:assert/strict";
import test from "node:test";
import { createHash, webcrypto } from "node:crypto";
import { emptyDiskBox } from "../../crates/triptych-host-wasm/web/disk-box.js";
import { launchRecipeDigest } from "../../crates/triptych-host-wasm/web/disk-launch.js";
import {
  diskBoxRuntimeDeployment,
  prepareDiskBoxRecipeLaunch,
} from "../../crates/triptych-host-wasm/web/disk-box-app-store.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let next = 0;
const options = {
  crypto: webcrypto,
  createId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
};
async function fixture() {
  const bootstrapBytes = new Uint8Array(256).fill(3),
    seed = new Uint8Array(2097152);
  const image = {
    id: "system",
    revision: "a".repeat(64),
    sha256: "a".repeat(64),
    name: "Original system",
    geometry: "triptych-cpm-2m-v1",
    byteLength: seed.length,
    source: "https://example.test/source",
    license: "MIT",
    systemProfile: "triptych-cpu-v0.1-2m-n04",
    url: "https://example.test/system.img",
  };
  const descriptor = {
    schema: "triptych-launch-recipe-v1",
    id: "starter",
    revision: "b".repeat(64),
    name: "Starter",
    configuredCount: 4,
    bootstrap: {
      profile: image.systemProfile,
      sha256: hash(bootstrapBytes),
      byteLength: 256,
    },
    slots: [
      { kind: "published", image },
      {
        kind: "writable-role",
        role: "work",
        name: "Work",
        geometry: image.geometry,
        seed: {
          sha256: hash(seed),
          byteLength: seed.length,
          systemProfile: null,
        },
      },
      null,
      null,
    ],
  };
  let materialized = 0;
  const resolved = {
    descriptor,
    digest: await launchRecipeDigest(descriptor, { crypto: webcrypto }),
    admission: { original: true },
    materialize: async () => {
      materialized++;
      return {
        descriptor,
        digest: resolved.digest,
        bootstrapBytes,
        seedBytes: new Map([["work", seed]]),
      };
    },
  };
  const first = await prepareDiskBoxRecipeLaunch(
    emptyDiskBox(),
    resolved,
    options,
  );
  const registry = {
    metadata: {
      recipes: [
        {
          id: descriptor.id,
          revision: descriptor.revision,
          configuredCount: 4,
          slots: [
            {
              kind: "published",
              image: { id: image.id, revision: image.revision },
            },
          ],
        },
      ],
    },
  };
  return { resolved, first, registry, materialized: () => materialized };
}

test("registry revisits never materialize assets or generate IDs; explicit fresh retains independent disks", async () => {
  const f = await fixture();
  assert.equal(f.materialized(), 1);
  const fresh = await prepareDiskBoxRecipeLaunch(f.first.manifest, f.resolved, {
    ...options,
    freshInstance: true,
  });
  assert.equal(f.materialized(), 2);
  assert.equal(fresh.manifest.personalDisks.length, 2);
  const reused = await prepareDiskBoxRecipeLaunch(fresh.manifest, f.resolved, {
    crypto: webcrypto,
    createId: () => assert.fail("reuse generated ID"),
  });
  assert.equal(reused.reused, true);
  assert.equal(f.materialized(), 2);
  assert.equal(reused.newBlobs.size, 0);
});

test("retained launch digest selects exact admission with A empty and never uses latest deployment", async () => {
  const f = await fixture();
  f.first.manifest.configurations[0].slots[0] = null;
  const result = await diskBoxRuntimeDeployment(f.first.manifest, {
    registry: f.registry,
    deployment: { latest: true },
    crypto: webcrypto,
    resolveRecipe: async (_registry, query) => {
      assert.deepEqual(query, {
        id: f.resolved.descriptor.id,
        revision: f.resolved.descriptor.revision,
      });
      return f.resolved;
    },
    resolveAdmission: () =>
      assert.fail("exact instance must not use ambiguous lookup"),
  });
  assert.equal(result, f.resolved.admission);
  assert.equal(f.materialized(), 1);
});

test("recovery lookup captures original binding/count/bootstrap before await and propagates ambiguity", async () => {
  const f = await fixture();
  const original = structuredClone(f.first.manifest.configurations[0]);
  let query;
  const result = diskBoxRuntimeDeployment(f.first.manifest, {
    registry: f.registry,
    crypto: {
      subtle: {
        digest: async (...args) => {
          f.first.manifest.configurations[0].systemDisk.image.id = "mutated";
          return webcrypto.subtle.digest(...args);
        },
      },
    },
    resolveRecipe: async () => ({ ...f.resolved, digest: "0".repeat(64) }),
    resolveAdmission: async (_registry, value) => {
      query = value;
      throw new Error("ambiguous retained admission");
    },
  });
  await assert.rejects(result, /ambiguous retained admission/);
  assert.deepEqual(query, {
    image: {
      id: original.systemDisk.image.id,
      revision: original.systemDisk.image.revision,
      sha256: original.systemDisk.image.sha256,
    },
    configuredCount: 4,
    bootstrapSha256: hash(Uint8Array.from(original.bootstrap.bytes)),
  });
});

test("personal recovery bindings retain historical deployment path without registry access", async () => {
  const f = await fixture(),
    config = f.first.manifest.configurations[0];
  config.systemDisk = config.slots[1];
  const deployment = { historical: true };
  assert.equal(
    await diskBoxRuntimeDeployment(f.first.manifest, {
      deployment,
      resolveRecipe: () => assert.fail("registry accessed"),
      resolveAdmission: () => assert.fail("registry accessed"),
    }),
    deployment,
  );
});
