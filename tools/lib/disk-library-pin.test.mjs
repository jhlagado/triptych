import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  writeFile,
  readFile,
  readdir,
  rm,
  mkdir,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  pinDiskLibraryPackage as pin,
  pinQualifiedDiskLibraryPackage as qualifiedPin,
} from "./disk-library-pin.mjs";
import { validateDiskLibraryRetention } from "./disk-library-retention.mjs";
import { readDiskLibraryPackage as read } from "./disk-library-package.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sorted = (value) =>
  Array.isArray(value)
    ? value.map(sorted)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, sorted(value[key])]),
        )
      : value;
function pinRecipeRevision(candidate) {
  const recipe = candidate.manifest.recipes[0];
  const { revision, ...portable } = recipe;
  recipe.revision = hash(Buffer.from(JSON.stringify(sorted(portable))));
  candidate.manifest.defaults = [{ id: recipe.id, revision: recipe.revision }];
}
const empty = () => ({
  schema: "triptych-disk-library-retention-v1",
  assets: [],
  images: [],
  admissions: [],
  recipes: [],
  defaults: [],
});
function release(version) {
  const manifest = empty(),
    assets = new Map();
  const add = (prefix, bytes, extension = "bin") => {
    const sha256 = hash(bytes),
      path = `${prefix}-${sha256}.${extension}`;
    assets.set(path, Uint8Array.from(bytes));
    manifest.assets.push({ path, bytes: bytes.length, sha256 });
    return path;
  };
  const json = (prefix, value) =>
    add(prefix, Buffer.from(JSON.stringify(value)), "json");
  const system = new Uint8Array(16384).fill(version),
    bootstrap = new Uint8Array(256).fill(version);
  const systemAsset = add("system", system),
    bootstrapAsset = add("bootstrap", bootstrap);
  const logicalSystem = "system-triptych-cpm-2m-n04-v1.bin",
    logicalBootstrap = "bootstrap-triptych-cpm-2m-n04-v1.bin";
  const profile = {
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
  };
  const envelope = json("admission", {
    schema: "triptych-browser-deployment-v1",
    twoMibProfiles: [profile],
    assets: [profile.system, profile.bootstrap].map(
      ({ asset, bytes, sha256 }) => ({ path: asset, bytes, sha256 }),
    ),
  });
  const admission = {
    id: hash(assets.get(envelope)),
    envelope,
    bindings: [
      { path: logicalSystem, asset: systemAsset },
      { path: logicalBootstrap, asset: bootstrapAsset },
    ],
  };
  manifest.admissions.push(admission);
  const bytes = new Uint8Array(2097152);
  bytes.set(system);
  const asset = add("image", bytes, "img"),
    revision = hash(bytes);
  manifest.images.push({
    id: "system",
    revision,
    name: "System",
    geometry: "triptych-cpm-2m-v1",
    byteLength: bytes.length,
    sha256: revision,
    asset,
    source: `https://example.test/${version}`,
    license: "test",
    systemProfile: profile.residentProfile,
  });
  const recipe = {
    id: "starter",
    revision: `revision-${version}`,
    name: "Starter",
    configuredCount: 4,
    admission: admission.id,
    bootstrap: bootstrapAsset,
    provenance: json("provenance", { version }),
    slots: [
      { kind: "published", image: { id: "system", revision } },
      null,
      null,
      null,
    ],
  };
  manifest.recipes.push(recipe);
  manifest.defaults.push({ id: recipe.id, revision: recipe.revision });
  return { manifest, assets };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "triptych-library-pin-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "disk-library-registry.json"),
    JSON.stringify(empty()),
  );
  return directory;
}
const raw = (directory) =>
  readFile(join(directory, "disk-library-registry.json"));

test("repeat pin preserves exact history; defaults advance only explicitly", async (t) => {
  const directory = await fixture(t),
    first = release(1),
    second = release(2);
  await pin(directory, first, { advanceDefaults: true });
  const firstManifest = await raw(directory),
    firstFiles = (await readdir(directory)).sort();
  await pin(directory, first);
  assert.deepEqual(await raw(directory), firstManifest);
  assert.deepEqual((await readdir(directory)).sort(), firstFiles);
  await pin(directory, second);
  let retained = await read(directory);
  assert.equal(retained.manifest.recipes.length, 2);
  assert.deepEqual(retained.manifest.defaults, first.manifest.defaults);
  for (const [path, bytes] of first.assets)
    assert.deepEqual(retained.assets.get(path), bytes);
  await pin(directory, second, { advanceDefaults: true });
  retained = await read(directory);
  assert.deepEqual(retained.manifest.defaults, second.manifest.defaults);
  assert.equal(retained.manifest.recipes.length, 2);
});

test("failed manifest publication leaves old authority intact and retry reuses completed assets", async (t) => {
  const directory = await fixture(t),
    first = release(1),
    second = release(2);
  await pin(directory, first, { advanceDefaults: true });
  const original = await raw(directory);
  await assert.rejects(
    pin(directory, second, {
      advanceDefaults: true,
      beforeManifestPublish: () => {
        throw new Error("interrupted");
      },
    }),
    /interrupted/,
  );
  assert.deepEqual(await raw(directory), original);
  assert.deepEqual(
    (await read(directory)).manifest.defaults,
    first.manifest.defaults,
  );
  for (const [path, bytes] of second.assets)
    assert.deepEqual(
      new Uint8Array(await readFile(join(directory, path))),
      bytes,
    );
  assert(!(await readdir(directory)).includes(".disk-library-pin.lock"));
  await pin(directory, second, { advanceDefaults: true });
  assert.equal((await read(directory)).manifest.recipes.length, 2);
});

test("corrupt candidate, retained bytes and conflicting orphan never replace authority", async (t) => {
  const directory = await fixture(t),
    first = release(1);
  const original = await raw(directory);
  first.assets.values().next().value[0] ^= 1;
  await assert.rejects(pin(directory, first), /hash/);
  assert.deepEqual(await raw(directory), original);
  const valid = release(1),
    [name, bytes] = valid.assets.entries().next().value;
  await writeFile(join(directory, name), new Uint8Array(bytes.length));
  await assert.rejects(pin(directory, valid), /collision/);
  assert.deepEqual(await raw(directory), original);
  const other = await fixture(t);
  await pin(other, valid);
  const authority = await raw(other);
  await writeFile(join(other, name), new Uint8Array(bytes.length));
  await assert.rejects(pin(other, release(2)), /hash/);
  assert.deepEqual(await raw(other), authority);
});

test("exclusive lock rejects concurrent writers and never removes a pre-existing lock", async (t) => {
  const directory = await fixture(t);
  let entered, resume;
  const paused = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    resume = resolve;
  });
  const first = pin(directory, release(1), {
    beforeManifestPublish: async () => {
      entered();
      await held;
    },
  });
  await paused;
  try {
    await assert.rejects(pin(directory, release(2)), /locked/);
  } finally {
    resume();
  }
  await first;
  assert.equal((await read(directory)).manifest.recipes.length, 1);
  const lock = join(directory, ".disk-library-pin.lock");
  await writeFile(lock, "interrupted old process");
  await assert.rejects(
    pin(directory, release(2)),
    /no automatic stale-lock removal/,
  );
  assert.equal(await readFile(lock, "utf8"), "interrupted old process");
});

test("same immutable image metadata conflict leaves manifest untouched", async (t) => {
  const directory = await fixture(t),
    first = release(1);
  await pin(directory, first);
  const original = await raw(directory),
    changed = release(1);
  changed.manifest.images[0].source = "https://example.test/rewritten";
  await assert.rejects(pin(directory, changed), /immutable images/);
  assert.deepEqual(await raw(directory), original);
});

test("CLI refuses dirty release evidence before invoking publisher", async (t) => {
  const directory = await fixture(t);
  const build = join(directory, "build");
  await mkdir(build);
  const revision = "1".repeat(40);
  await writeFile(
    join(build, "deployment-manifest.json"),
    JSON.stringify({
      schema: "triptych-browser-deployment-v1",
      storageSchema: "triptych-disk-box-v1",
      distribution: { triptych: { revision, dirty: true } },
    }),
  );
  const original = await raw(directory);
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      resolve(import.meta.dirname, "../pin-disk-library.mjs"),
      build,
      revision,
      "--history",
      directory,
      "--advance-defaults",
    ]),
    (error) =>
      error.code === 1 &&
      error.stderr.includes("refusing to pin a dirty development build"),
  );
  assert.deepEqual(await raw(directory), original);
  assert.deepEqual((await readdir(directory)).sort(), [
    "build",
    "disk-library-registry.json",
  ]);
});

test("browser gate rejects changed portable metadata before any lock or asset write", async (t) => {
  const directory = await fixture(t),
    candidate = release(1);
  pinRecipeRevision(candidate);
  candidate.manifest.recipes[0].name = "Changed without a new revision";
  assert.doesNotThrow(
    () => validateDiskLibraryRetention(candidate),
    "generic retention intentionally has a broader contract",
  );
  const original = await raw(directory);
  await assert.rejects(
    qualifiedPin(directory, candidate),
    /portable recipe revision differs/,
  );
  assert.deepEqual(await raw(directory), original);
  assert.deepEqual(await readdir(directory), ["disk-library-registry.json"]);
});

test("browser gate resolves nondefault retained recipes and rejects skeletal admission before writes", async (t) => {
  const directory = await fixture(t),
    candidate = release(1);
  pinRecipeRevision(candidate);
  // No defaults: a gate checking only current launch buttons would miss this.
  candidate.manifest.defaults = [];
  assert.doesNotThrow(() => validateDiskLibraryRetention(candidate));
  const original = await raw(directory);
  await assert.rejects(
    qualifiedPin(directory, candidate),
    /Two-MiB profile: unsupported descriptor fields/,
  );
  assert.deepEqual(await raw(directory), original);
  assert.deepEqual(await readdir(directory), ["disk-library-registry.json"]);
});
