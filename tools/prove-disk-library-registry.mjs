// Host distribution proof against an existing build; never builds or serves.
// Run: node tools/prove-disk-library-registry.mjs [distribution-directory]
// Current defaults only: this does not prove retained older releases or browser UI.
import assert from "node:assert/strict";
import { createHash, webcrypto as crypto } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import {
  loadDiskLibraryRegistry,
  resolveDiskLibraryRecipe,
  resolveDiskLibraryAdmission,
} from "../crates/triptych-host-wasm/web/disk-library-registry.js";
import { fetchPublishedImage } from "../crates/triptych-host-wasm/web/disk-catalogue.js";

const root = resolve(import.meta.dirname, "..");
const directory = resolve(
  process.argv[2] ?? resolve(root, "dist/wasm-browser"),
);
const baseUrl = "https://distribution.invalid/triptych/";
const requests = [];
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { CpmDisk } = createRequire(import.meta.url)(
  resolve(root, "dist/wasm/triptych_host_wasm.js"),
);
async function fetch(url, options) {
  const target = new URL(url);
  assert.equal(target.origin, new URL(baseUrl).origin);
  assert.equal(new URL(".", target).href, baseUrl);
  assert.equal(
    target.search + target.hash + target.username + target.password,
    "",
  );
  assert.deepEqual(options, { cache: "no-store", redirect: "error" });
  const name = target.pathname.slice(new URL(baseUrl).pathname.length);
  assert.match(name, /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
  requests.push(name);
  const path = resolve(directory, name);
  const info = await stat(path);
  assert(
    info.isFile() && info.size <= 16 * 1024 * 1024,
    "bounded regular asset",
  );
  const bytes = await readFile(path);
  assert.equal(bytes.length, info.size, "asset changed while reading");
  return new Response(bytes, {
    headers: { "content-length": String(bytes.length) },
  });
}
function files(bytes) {
  const disk = new CpmDisk(bytes);
  try {
    return disk.file_names().sort();
  } finally {
    disk.free();
  }
}

const registry = await loadDiskLibraryRegistry({ baseUrl, fetch, crypto });
assert.deepEqual(requests, ["disk-library-registry.json"]);
assert.deepEqual(registry.metadata.defaults.map((row) => row.id).sort(), [
  "library",
  "starter",
]);
const results = [];
for (const reference of registry.metadata.defaults) {
  const portable = registry.metadata.recipes.find(
    (row) => row.id === reference.id && row.revision === reference.revision,
  );
  assert(portable);
  const admissionRow = registry.metadata.admissions.find(
    (row) => row.id === portable.admission,
  );
  const start = requests.length;
  const recipe = await resolveDiskLibraryRecipe(registry, reference);
  const current = await resolveDiskLibraryRecipe(registry, {
    default: reference.id,
  });
  assert.deepEqual(current.reference, reference);
  assert.equal(current.digest, recipe.digest);
  assert(
    requests
      .slice(start)
      .every((name) =>
        [admissionRow.envelope, portable.provenance].includes(name),
      ),
    "preview fetched a payload",
  );
  assert.equal(hash(recipe.admissionBytes), admissionRow.id);
  assert.equal(recipe.descriptor.configuredCount, 4);
  const profile = recipe.admission.twoMibProfiles.find(
    (row) => row.configuredCount === 4,
  );
  assert.equal(profile.residentProfile, "triptych-cpu-v0.1-2m-n04");
  const systemRef = recipe.descriptor.slots[0].image;
  const matched = await resolveDiskLibraryAdmission(registry, {
    image: {
      id: systemRef.id,
      revision: systemRef.revision,
      sha256: systemRef.sha256,
    },
    configuredCount: 4,
    bootstrapSha256: recipe.descriptor.bootstrap.sha256,
  });
  assert.equal(matched.admissionId, recipe.admissionId);
  const materialized = await recipe.materialize();
  assert.equal(materialized.bootstrapBytes.length, 256);
  assert.equal(hash(materialized.bootstrapBytes), profile.bootstrap.sha256);
  const roles = recipe.descriptor.slots.filter(
    (slot) => slot?.kind === "writable-role",
  );
  assert.deepEqual(
    [...materialized.seedBytes.keys()].sort(),
    reference.id === "starter" ? ["saves", "work"] : [],
  );
  for (const role of roles) {
    const bytes = materialized.seedBytes.get(role.role);
    assert.equal(bytes.length, role.seed.byteLength);
    assert.equal(hash(bytes), role.seed.sha256);
    assert.deepEqual(
      files(bytes),
      [],
      "new writable role must be a valid empty CP/M disk",
    );
  }
  const images = [];
  for (const slot of recipe.descriptor.slots.filter(
    (slot) => slot?.kind === "published",
  )) {
    const bytes = await fetchPublishedImage(slot.image, { fetch, crypto });
    assert.equal(bytes.length, slot.image.byteLength);
    assert.equal(hash(bytes), slot.image.sha256);
    const names = files(bytes);
    if (slot.image.systemProfile !== null) {
      assert.equal(slot.image.systemProfile, profile.residentProfile);
      assert.equal(
        hash(bytes.subarray(0, profile.system.bytes)),
        profile.system.sha256,
      );
      assert(names.includes("ATOM.COM"));
    } else {
      assert(names.includes("CAVERNS.COM") && names.includes("HYPERDRV.COM"));
    }
    images.push({
      id: slot.image.id,
      sha256: hash(bytes),
      files: names.length,
    });
  }
  assert.equal(images.length, 2);
  // Verify the retained logical-name bindings as actual emitted bytes too.
  for (const binding of Object.values(recipe.assetBindings)) {
    const bytes = new Uint8Array(
      await (
        await fetch(binding.url, { cache: "no-store", redirect: "error" })
      ).arrayBuffer(),
    );
    assert.equal(bytes.length, binding.byteLength);
    assert.equal(hash(bytes), binding.sha256);
  }
  results.push({
    ...reference,
    admission: recipe.admissionId,
    profile: profile.residentProfile,
    roles: roles.map((role) => role.role),
    images,
  });
}
console.log(
  JSON.stringify(
    {
      proof: "current-built-library-distribution",
      directory,
      recipes: results,
      requests: requests.length,
      scope:
        "Node host distribution only; not older-release retention, browser UI, hosting or hardware",
    },
    null,
    2,
  ),
);
