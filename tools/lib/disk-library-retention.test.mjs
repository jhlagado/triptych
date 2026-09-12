import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  validateDiskLibraryRetention as validate,
  mergeDiskLibraryRetention as merge,
} from "./disk-library-retention.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function release(version) {
  const manifest = {
      schema: "triptych-disk-library-retention-v1",
      assets: [],
      images: [],
      admissions: [],
      recipes: [],
      defaults: [],
    },
    assets = new Map();
  const add = (prefix, bytes, extension = "bin") => {
    const sha256 = hash(bytes),
      path = `${prefix}-${sha256}.${extension}`;
    assets.set(path, Uint8Array.from(bytes));
    manifest.assets.push({ path, bytes: bytes.length, sha256 });
    return path;
  };
  const json = (prefix, value) =>
    add(prefix, Buffer.from(JSON.stringify(value, null, 2) + "\n"), "json");
  const system = new Uint8Array(16384).fill(version),
    bootstrap = new Uint8Array(256).fill(version);
  const systemAsset = add("system", system),
    bootstrapAsset = add("bootstrap", bootstrap);
  const logicalSystem = "system-triptych-cpm-2m-n04-v1.bin",
    logicalBootstrap = "bootstrap-triptych-cpm-2m-n04-v1.bin";
  const envelope = {
    schema: "triptych-browser-deployment-v1",
    twoMibProfiles: [
      {
        configuredCount: 4,
        residentProfile: "triptych-cpu-v0.1-2m-n04",
        system: {
          asset: logicalSystem,
          bytes: system.length,
          sha256: hash(system),
        },
        bootstrap: {
          asset: logicalBootstrap,
          bytes: bootstrap.length,
          sha256: hash(bootstrap),
        },
      },
    ],
    assets: [
      { path: logicalSystem, bytes: system.length, sha256: hash(system) },
      {
        path: logicalBootstrap,
        bytes: bootstrap.length,
        sha256: hash(bootstrap),
      },
    ],
  };
  const admission = {
    id: `qualification-${version}`,
    envelope: json("admission", envelope),
    bindings: [
      { path: logicalSystem, asset: systemAsset },
      { path: logicalBootstrap, asset: bootstrapAsset },
    ],
  };
  manifest.admissions.push(admission);
  const imageBytes = new Uint8Array(2097152);
  imageBytes.set(system);
  const imageAsset = add("library-system", imageBytes, "img"),
    revision = hash(imageBytes);
  manifest.images.push({
    id: "system-2m-n04",
    revision,
    name: "System",
    geometry: "triptych-cpm-2m-v1",
    byteLength: imageBytes.length,
    sha256: revision,
    asset: imageAsset,
    source: `https://example.test/source/${version}`,
    license: "GPL-3.0-only",
    systemProfile: "triptych-cpu-v0.1-2m-n04",
  });
  const seed = add("seed", new Uint8Array(2097152), "img");
  const recipe = {
    id: "starter",
    revision: `revision-${version}`,
    name: "Starter",
    configuredCount: 4,
    admission: admission.id,
    bootstrap: bootstrapAsset,
    provenance: json("provenance", { source: version }),
    slots: [
      { kind: "published", image: { id: "system-2m-n04", revision } },
      {
        kind: "writable-role",
        role: "work",
        name: "Work",
        geometry: "triptych-cpm-2m-v1",
        seed: { asset: seed, systemProfile: null },
      },
      null,
      null,
    ],
  };
  manifest.recipes.push(recipe);
  manifest.defaults.push({ id: recipe.id, revision: recipe.revision });
  return { manifest, assets };
}

test("A to B retains old recipes, images, exact admission bytes, seeds and provenance", () => {
  const first = release(1),
    second = release(2);
  const merged = merge(first, second, { defaults: second.manifest.defaults });
  assert.equal(merged.manifest.recipes.length, 2);
  assert.equal(merged.manifest.images.length, 2);
  assert.deepEqual(merged.manifest.defaults, second.manifest.defaults);
  const old = merged.manifest.recipes.find(
    (row) => row.revision === "revision-1",
  );
  assert.deepEqual(old, first.manifest.recipes[0]);
  const admission = merged.manifest.admissions.find(
    (row) => row.id === old.admission,
  );
  assert.deepEqual(admission, first.manifest.admissions[0]);
  for (const [path, bytes] of first.assets)
    assert.deepEqual(merged.assets.get(path), bytes);
  assert(
    merged.assets.size < first.assets.size + second.assets.size,
    "identical seed deduplicates",
  );
  const originalBootstrap = first.assets.get(old.bootstrap);
  merged.assets.get(old.bootstrap).fill(90);
  assert.deepEqual(
    originalBootstrap,
    new Uint8Array(256).fill(1),
    "returned bytes are owned",
  );
});

test("omission retains all history and defaults only advance explicitly", () => {
  const first = release(1),
    second = release(2),
    result = merge(first, second);
  assert.deepEqual(result.manifest.defaults, first.manifest.defaults);
  const replay = merge(result, second);
  assert.deepEqual(replay.manifest, result.manifest);
  assert.equal(replay.assets.size, result.assets.size);
  assert.throws(
    () =>
      merge(first, second, {
        defaults: [{ id: "starter", revision: "missing" }],
      }),
    /default recipe is missing/,
  );
});

test("same immutable identity cannot change metadata or resolved bytes", () => {
  const first = release(1),
    renamed = release(1);
  renamed.manifest.images[0].source = "https://example.test/new-source";
  assert.throws(
    () => merge(first, renamed),
    /immutable images identity changed/,
  );
  const changedRecipe = release(2);
  changedRecipe.manifest.recipes[0].revision = "revision-1";
  changedRecipe.manifest.defaults[0].revision = "revision-1";
  assert.throws(
    () => merge(first, changedRecipe),
    /immutable recipes identity changed/,
  );
  const changedAdmission = release(2);
  changedAdmission.manifest.admissions[0].id = "qualification-1";
  changedAdmission.manifest.recipes[0].admission = "qualification-1";
  assert.throws(
    () => merge(first, changedAdmission),
    /immutable admissions identity changed/,
  );
});

test("missing, corrupted, unlisted and incorrectly named payloads reject", () => {
  for (const mutate of [
    ({ assets }) => assets.delete(assets.keys().next().value),
    ({ assets }) => assets.values().next().value.fill(99),
    ({ assets }) => assets.set("extra", new Uint8Array()),
    ({ manifest }) => {
      manifest.assets[0].path = "../escape.bin";
    },
    ({ manifest }) => {
      manifest.assets[0].path = "not-content-addressed.bin";
    },
    ({ manifest }) => {
      manifest.assets[0].bytes = 1024 * 1024 * 1024;
    },
  ]) {
    const data = release(1);
    mutate(data);
    assert.throws(() => validate(data), /Disk library retention/);
  }
});

test("dangling image, seed, provenance, bootstrap and admission bindings reject", () => {
  for (const mutate of [
    ({ manifest }) => {
      manifest.recipes[0].slots[0].image.revision = "missing";
    },
    ({ manifest }) => {
      manifest.recipes[0].slots[1].seed.asset = "missing.img";
    },
    ({ manifest }) => {
      manifest.recipes[0].provenance = "missing.json";
    },
    ({ manifest }) => {
      manifest.recipes[0].bootstrap = manifest.recipes[0].slots[1].seed.asset;
    },
    ({ manifest }) => {
      manifest.admissions[0].bindings.pop();
    },
    ({ manifest }) => {
      manifest.recipes[0].admission = "missing";
    },
    ({ manifest }) => {
      manifest.recipes[0].slots[0] = null;
    },
  ]) {
    const data = release(1);
    mutate(data);
    assert.throws(() => validate(data), /Disk library retention/);
  }
});

test("accessors, unsupported metadata, duplicate identities and oversized metadata reject", () => {
  const data = release(1);
  Object.defineProperty(data.manifest.recipes[0], "name", {
    enumerable: true,
    get() {
      throw new Error("getter invoked");
    },
  });
  assert.throws(() => validate(data), /accessor/);
  const duplicate = release(1);
  duplicate.manifest.recipes.push(duplicate.manifest.recipes[0]);
  assert.throws(() => validate(duplicate), /duplicate recipe/);
  const nonJson = release(1);
  nonJson.manifest.defaults = new Map();
  assert.throws(() => validate(nonJson), /non-JSON/);
  const oversized = release(1);
  oversized.manifest.recipes[0].name = "x".repeat(3 * 1024 * 1024);
  assert.throws(() => validate(oversized), /metadata exceeds bound/);
});

test("asset validation hashes intrinsic bytes rather than an overridden iterator", () => {
  const data = release(1),
    path = data.assets.keys().next().value;
  const source = data.assets.get(path);
  source.fill(99);
  source[Symbol.iterator] = function* () {
    for (let i = 0; i < 16384; i++) yield 1;
  };
  assert.throws(() => validate(data), /asset hash differs/);
});

test("asset byte access ignores auxiliary getters and respects view offsets", () => {
  const data = release(1),
    path = data.assets.keys().next().value;
  const backing = new Uint8Array(16388).fill(99);
  backing.set(data.assets.get(path), 2);
  const source = backing.subarray(2, 16386);
  for (const field of ["buffer", "byteOffset", "byteLength"])
    Object.defineProperty(source, field, {
      get() {
        throw new Error("auxiliary getter invoked");
      },
    });
  data.assets.set(path, source);
  assert.deepEqual(
    validate(data).assets.get(path),
    new Uint8Array(16384).fill(1),
  );
});

test("default and image identities cannot coerce numbers into matching strings", () => {
  for (const [kind, field] of [
    ["default", "id"],
    ["default", "revision"],
    ["image", "id"],
    ["image", "revision"],
  ]) {
    const data = release(1);
    if (kind === "default") {
      data.manifest.recipes[0][field] = "1";
      data.manifest.defaults[0][field] = 1;
    } else {
      data.manifest.images[0][field] = "1";
      data.manifest.recipes[0].slots[0].image[field] = 1;
    }
    assert.throws(() => validate(data), /invalid identity/, `${kind}.${field}`);
  }
});
