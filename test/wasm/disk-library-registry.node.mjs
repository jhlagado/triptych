import assert from "node:assert/strict";
import { createHash, webcrypto as crypto } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { buildTwoMibSystem } from "../../tools/lib/two-mib-system.mjs";
import {
  loadDiskLibraryRegistry as load,
  resolveDiskLibraryRecipe as resolve,
  resolveDiskLibraryAdmission as admissionFor,
} from "../../crates/triptych-host-wasm/web/disk-library-registry.js";

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
// Qualify the actual pinned N4 sources once, entirely in memory through ATOM.
// A clean check runs these tests before the browser build exists. The deployed
// registry/Pages proof is separate; no fixture reads or writes build outputs.
let sourceSystem;
async function fixture() {
  sourceSystem ??= buildTwoMibSystem(
    fileURLToPath(new URL("../../", import.meta.url)),
    4,
    { allowDirty: true },
  );
  const qualified = await sourceSystem;
  const profile = structuredClone(qualified.descriptor);
  const manifest = {
      schema: "triptych-disk-library-retention-v1",
      assets: [],
      images: [],
      admissions: [],
      recipes: [],
      defaults: [],
    },
    bodies = new Map();
  const add = (prefix, bytes, extension) => {
    const sha256 = hash(bytes),
      path = `${prefix}-${sha256}.${extension}`;
    bodies.set(path, Uint8Array.from(bytes));
    manifest.assets.push({ path, bytes: bytes.length, sha256 });
    return path;
  };
  const json = (prefix, value) =>
    add(prefix, Buffer.from(JSON.stringify(value, null, 2) + "\n"), "json");
  const system = qualified.system.slice(),
    boot = qualified.bootstrap.slice();
  const systemAsset = add("system", system, "bin"),
    bootstrap = add("bootstrap", boot, "bin");
  const envelope = {
    schema: "triptych-browser-deployment-v1",
    twoMibProfiles: [profile],
    assets: [profile.system, profile.bootstrap].map((ref) => ({
      path: ref.asset,
      bytes: ref.bytes,
      sha256: ref.sha256,
    })),
  };
  const envelopePath = json("admission", envelope);
  manifest.admissions.push({
    id: hash(bodies.get(envelopePath)),
    envelope: envelopePath,
    bindings: [
      { path: profile.system.asset, asset: systemAsset },
      { path: profile.bootstrap.asset, asset: bootstrap },
    ],
  });
  const image = new Uint8Array(2097152);
  image.set(system);
  const asset = add("image", image, "img");
  manifest.images.push({
    id: "system",
    revision: hash(image),
    name: "System",
    geometry: "triptych-cpm-2m-v1",
    byteLength: image.length,
    sha256: hash(image),
    asset,
    source: "https://example.test/source",
    license: "GPL-3.0-or-later",
    systemProfile: profile.residentProfile,
  });
  const seed = add("seed", new Uint8Array(2097152), "img"),
    provenance = json("provenance", { source: "captured test assets" });
  for (const version of [1, 2]) {
    const portable = {
      id: "starter",
      name: `Starter ${version}`,
      configuredCount: 4,
      admission: manifest.admissions[0].id,
      bootstrap,
      provenance,
      slots: [
        { kind: "published", image: { id: "system", revision: hash(image) } },
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
    manifest.recipes.push({
      ...portable,
      revision: hash(Buffer.from(JSON.stringify(sorted(portable)))),
    });
  }
  manifest.defaults = [
    { id: "starter", revision: manifest.recipes[1].revision },
  ];
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    const path = new URL(url).pathname.split("/").at(-1);
    const bytes =
      path === "disk-library-registry.json"
        ? Buffer.from(JSON.stringify(manifest))
        : bodies.get(path);
    return bytes
      ? new Response(bytes, {
          headers: { "content-length": String(bytes.length) },
        })
      : new Response("missing", { status: 404 });
  };
  return {
    manifest,
    bodies,
    calls,
    fetch,
    profile,
    envelopePath,
    seed,
    add,
    json,
  };
}
const baseUrl = "https://example.test/app/index.html";

test("accepts decoded response bytes when HTTP content encoding changes the wire length", async () => {
  const f = await fixture();
  const encodedFetch = async (url, options) => {
    const response = await f.fetch(url, options);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new Response(bytes, {
      status: response.status,
      headers: {
        "content-encoding": "gzip",
        "content-length": String(Math.max(1, Math.floor(bytes.length / 2))),
      },
    });
  };
  const registry = await load({ baseUrl, fetch: encodedFetch, crypto });
  assert.equal(registry.metadata.defaults[0].id, "starter");
});

test("old retained admission stays exact when the default resident bytes change", async () => {
  const f = await fixture();
  const oldReference = {
    id: f.manifest.recipes[0].id,
    revision: f.manifest.recipes[0].revision,
  };
  const newer = f.manifest.recipes[1];
  const oldImage = f.manifest.images[0];
  const image = Uint8Array.from(f.bodies.get(oldImage.asset));
  // Deliberately synthetic resident variant: this proves retained byte/evidence
  // selection, not that this modified instruction stream is a qualified OS.
  image[100] ^= 1;
  const resident = image.slice(0, 16384);
  const envelope = JSON.parse(
    new TextDecoder().decode(f.bodies.get(f.envelopePath)),
  );
  const profile = envelope.twoMibProfiles[0];
  profile.system.sha256 = hash(resident);
  profile.residents.ccp.sha256 = hash(resident.subarray(0, 2048));
  envelope.assets.find((row) => row.path === profile.system.asset).sha256 =
    hash(resident);
  const residentAsset = f.add("system-new", resident, "bin");
  const envelopePath = f.json("admission-new", envelope);
  const admission = {
    id: hash(f.bodies.get(envelopePath)),
    envelope: envelopePath,
    bindings: f.manifest.admissions[0].bindings.map((row) => ({
      ...row,
      asset: row.path === profile.system.asset ? residentAsset : row.asset,
    })),
  };
  f.manifest.admissions.push(admission);
  const newImage = {
    ...oldImage,
    revision: hash(image),
    sha256: hash(image),
    asset: f.add("image-new", image, "img"),
  };
  f.manifest.images.push(newImage);
  newer.admission = admission.id;
  newer.slots[0].image.revision = newImage.revision;
  delete newer.revision;
  newer.revision = hash(Buffer.from(JSON.stringify(sorted(newer))));
  f.manifest.defaults[0].revision = newer.revision;
  const registry = await load({ baseUrl, fetch: f.fetch, crypto });
  const old = await resolve(registry, oldReference);
  const current = await resolve(registry, { default: "starter" });
  assert.notEqual(old.admissionId, current.admissionId);
  assert.deepEqual(old.admissionBytes, f.bodies.get(f.envelopePath));
  assert.deepEqual(current.admissionBytes, f.bodies.get(envelopePath));
  assert.equal(old.descriptor.slots[0].image.sha256, oldImage.sha256);
  assert.equal(current.descriptor.slots[0].image.sha256, newImage.sha256);
  assert.equal(
    old.admission.twoMibProfiles[0].system.sha256,
    f.profile.system.sha256,
  );
  assert.equal(
    current.admission.twoMibProfiles[0].system.sha256,
    hash(resident),
  );
  assert.notEqual(
    old.assetBindings[profile.system.asset].url,
    current.assetBindings[profile.system.asset].url,
  );
  assert(f.calls.every((call) => call.url.endsWith(".json")));
  for (const [imageRef, expected] of [
    [oldImage, old],
    [newImage, current],
  ]) {
    const recovered = await admissionFor(registry, {
      image: {
        id: imageRef.id,
        revision: imageRef.revision,
        sha256: imageRef.sha256,
      },
      configuredCount: 4,
      bootstrapSha256: f.profile.bootstrap.sha256,
    });
    assert.equal(recovered.admissionId, expected.admissionId);
  }
});

test("same image and bootstrap with distinct admitted evidence requires exact recipe selection", async () => {
  const f = await fixture();
  const envelope = JSON.parse(
    new TextDecoder().decode(f.bodies.get(f.envelopePath)),
  );
  envelope.twoMibProfiles[0].residents.lockSha256 = "1".repeat(64);
  const envelopePath = f.json("admission-evidence", envelope);
  const admission = {
    ...f.manifest.admissions[0],
    id: hash(f.bodies.get(envelopePath)),
    envelope: envelopePath,
  };
  f.manifest.admissions.push(admission);
  const newer = f.manifest.recipes[1];
  newer.admission = admission.id;
  delete newer.revision;
  newer.revision = hash(Buffer.from(JSON.stringify(sorted(newer))));
  f.manifest.defaults[0].revision = newer.revision;
  const registry = await load({ baseUrl, fetch: f.fetch, crypto });
  const image = f.manifest.images[0];
  await assert.rejects(
    admissionFor(registry, {
      image: { id: image.id, revision: image.revision, sha256: image.sha256 },
      configuredCount: 4,
      bootstrapSha256: f.profile.bootstrap.sha256,
    }),
    /ambiguous/,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await resolve(registry, { default: "starter" })).admissionId,
    admission.id,
  );
});

test("old explicit revision and new default resolve metadata only; materialization is deferred", async () => {
  const f = await fixture(),
    registry = await load({ baseUrl, fetch: f.fetch, crypto });
  assert.equal(f.calls.length, 1);
  await assert.rejects(
    admissionFor(registry, {
      image: {
        ...f.manifest.recipes[0].slots[0].image,
        sha256: "0".repeat(64),
      },
      configuredCount: 4,
      bootstrapSha256: f.profile.bootstrap.sha256,
    }),
    /missing/,
  );
  const old = await resolve(registry, {
    id: "starter",
    revision: f.manifest.recipes[0].revision,
  });
  assert.equal(old.descriptor.name, "Starter 1");
  assert.deepEqual(old.admissionBytes, f.bodies.get(f.envelopePath));
  assert.equal(
    old.admission.twoMibProfiles[0].system.asset,
    f.profile.system.asset,
  );
  assert(
    old.assetBindings[f.profile.system.asset].url.endsWith(
      `-${f.profile.system.sha256}.bin`,
    ),
  );
  assert(f.calls.every((call) => call.url.endsWith(".json")));
  assert.equal(
    (await resolve(registry, { default: "starter" })).descriptor.name,
    "Starter 2",
  );
  const recovered = await admissionFor(registry, {
    image: {
      ...f.manifest.recipes[0].slots[0].image,
      sha256: f.manifest.images[0].sha256,
    },
    configuredCount: 4,
    bootstrapSha256: f.profile.bootstrap.sha256,
  });
  assert.equal(recovered.admissionId, old.admissionId);
  const materialized = await old.materialize();
  assert.equal(hash(materialized.bootstrapBytes), f.profile.bootstrap.sha256);
  assert.equal(materialized.seedBytes.get("work").length, 2097152);
  assert(
    !f.calls.some((call) => call.url.includes("/image-")),
    "published system image is not copied for recipe materialization",
  );
  for (const call of f.calls)
    assert.deepEqual(call.options, { cache: "no-store", redirect: "error" });
});

test("portable revision survives origin changes while runtime digest resolves exact URLs", async () => {
  const f = await fixture();
  const first = await resolve(await load({ baseUrl, fetch: f.fetch, crypto }), {
    default: "starter",
  });
  const second = await resolve(
    await load({
      baseUrl: "https://other.test/mirror/",
      fetch: f.fetch,
      crypto,
    }),
    { default: "starter" },
  );
  assert.deepEqual(first.reference, second.reference);
  assert.notEqual(first.digest, second.digest);
  assert.throws(() => {
    first.descriptor.slots[0].image.sha256 = "0".repeat(64);
  }, TypeError);
  first.admissionBytes.fill(0);
  assert.equal((await first.materialize()).bootstrapBytes.length, 256);
});

test("unknown revisions and same-bootstrap wrong system identities never fallback", async () => {
  const f = await fixture(),
    registry = await load({ baseUrl, fetch: f.fetch, crypto });
  await assert.rejects(
    resolve(registry, { id: "starter", revision: "missing" }),
    /unknown/,
  );
  await assert.rejects(resolve(registry, { default: "absent" }), /unknown/);
  await assert.rejects(
    resolve(registry, { id: 2, revision: f.manifest.recipes[0].revision }),
    /identity/,
  );
  await assert.rejects(
    admissionFor(registry, {
      image: {
        id: "system",
        revision: "missing",
        sha256: f.manifest.images[0].sha256,
      },
      configuredCount: 4,
      bootstrapSha256: f.profile.bootstrap.sha256,
    }),
    /missing/,
  );
  assert.equal(f.calls.length, 1);
});

test("changed portable metadata, dangling bindings and numeric identities reject", async () => {
  for (const mutate of [
    (f) => {
      f.manifest.recipes[0].name = "changed";
    },
    (f) => {
      f.manifest.admissions[0].bindings[0].asset = "missing.bin";
    },
    (f) => {
      f.manifest.recipes[0].id = 7;
    },
    (f) => {
      f.manifest.defaults.push(f.manifest.defaults[0]);
    },
    (f) => {
      f.manifest.assets[0].extra = true;
    },
    (f) => {
      f.manifest.images[0].revision = "unpinned";
    },
    (f) => {
      f.manifest.admissions[0].id = "unpinned";
    },
  ]) {
    const f = await fixture();
    mutate(f);
    await assert.rejects(load({ baseUrl, fetch: f.fetch, crypto }));
  }
});

test("admission corruption and seed corruption fail without replacement fetches", async () => {
  const f = await fixture(),
    registry = await load({ baseUrl, fetch: f.fetch, crypto });
  f.bodies.get(f.envelopePath)[0] ^= 1;
  await assert.rejects(
    resolve(registry, { default: "starter" }),
    /hash differs/,
  );
  f.bodies.get(f.envelopePath)[0] ^= 1;
  const recipe = await resolve(registry, { default: "starter" });
  f.bodies.get(f.seed)[0] ^= 1;
  await assert.rejects(recipe.materialize(), /hash differs/);
});

test("cross-origin registry URLs, redirects, oversize chunks and duplicate JSON fields reject", async () => {
  const f = await fixture();
  await assert.rejects(
    load({
      baseUrl,
      url: "https://other.test/disk-library-registry.json",
      fetch: f.fetch,
      crypto,
    }),
    /outside/,
  );
  await assert.rejects(
    load({ baseUrl, url: "nested/registry.json", fetch: f.fetch, crypto }),
    /outside/,
  );
  await assert.rejects(
    load({
      baseUrl,
      fetch: async () => ({ ok: true, redirected: true }),
      crypto,
    }),
    /redirect/,
  );
  await assert.rejects(
    load({
      baseUrl,
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new Uint8Array(16 * 1024 * 1024 + 1));
              c.close();
            },
          }),
        ),
      crypto,
    }),
    /bound/,
  );
  await assert.rejects(
    load({
      baseUrl,
      fetch: async () => new Response('{"schema":1,"schema":2}'),
      crypto,
    }),
    /duplicate/,
  );
  await assert.rejects(
    load({
      baseUrl,
      fetch: async () =>
        new Response("{}", { headers: { "content-length": "2,2" } }),
      crypto,
    }),
    /length/,
  );
});
