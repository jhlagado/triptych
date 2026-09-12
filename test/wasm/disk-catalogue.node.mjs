import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import {
  validateDiskCatalogue,
  publishedImageReference,
  validatePublishedImageReference,
  fetchPublishedImage,
} from "../../crates/triptych-host-wasm/web/disk-catalogue.js";

const bytes = new Uint8Array(256512).fill(7);
const digest = createHash("sha256").update(bytes).digest("hex");
const row = () => ({
  id: "system",
  revision: "v1.0",
  name: "System disk",
  geometry: "ibm3740",
  byteLength: bytes.length,
  sha256: digest,
  asset: "system.img",
  source: "https://example.org/source",
  license: "MIT",
  systemProfile: "legacy-e400",
});
const catalogue = () => ({
  schema: "triptych-disk-catalogue-v1",
  images: [row()],
});
const reference = () =>
  publishedImageReference(
    catalogue(),
    "system",
    "v1.0",
    "https://example.org/site/",
  );

test("catalogue validates exact geometries, profiles, identities and detached references", () => {
  const input = catalogue();
  const validated = validateDiskCatalogue(input);
  input.images[0].name = "changed";
  assert.equal(validated.images[0].name, "System disk");
  assert.equal(reference().url, "https://example.org/site/system.img");
  for (const [geometry, byteLength, systemProfile] of [
    ["ibm3740", 256512, "legacy-e400"],
    ["triptych-cpm-8m-v1", 8388608, "triptych-cpu-v0.1-8m-ab"],
    ["triptych-cpm-2m-v1", 2097152, "triptych-cpu-v0.1-2m-n16"],
  ]) {
    validateDiskCatalogue({
      schema: catalogue().schema,
      images: [{ ...row(), geometry, byteLength, systemProfile }],
    });
  }
  for (const patch of [
    { id: "../disk" },
    { revision: "" },
    { name: "x".repeat(256) },
    { name: "\ud800" },
    { byteLength: 256256 },
    { geometry: "unknown" },
    { sha256: digest.toUpperCase() },
    { systemProfile: "triptych-cpu-v0.1-2m-n04" },
    { asset: "../disk.img" },
    { asset: "disk.img?x" },
    { asset: "%2e.img" },
    { source: "https://user:pass@example.org/" },
    { license: "" },
    { unexpected: 1 },
  ]) {
    assert.throws(() =>
      validateDiskCatalogue({
        schema: catalogue().schema,
        images: [{ ...row(), ...patch }],
      }),
    );
  }
  assert.throws(
    () => validateDiskCatalogue({ ...catalogue(), images: [row(), row()] }),
    /duplicate/,
  );
  assert.throws(() =>
    validateDiskCatalogue({ ...catalogue(), images: Array(1) }),
  );
  assert.throws(() => validateDiskCatalogue({ ...catalogue(), extra: true }));
  const symbolic = catalogue();
  symbolic.images[Symbol("extra")] = 1;
  assert.throws(() => validateDiskCatalogue(symbolic));
  validateDiskCatalogue({
    ...catalogue(),
    images: [
      { ...row(), name: "😀".repeat(63), systemProfile: null },
      { ...row(), revision: "v2" },
    ],
  });
  assert.throws(() =>
    validateDiskCatalogue({
      ...catalogue(),
      images: [{ ...row(), name: "😀".repeat(64) }],
    }),
  );
  const accessor = row();
  Object.defineProperty(accessor, "name", { get: () => "name" });
  assert.throws(() =>
    validateDiskCatalogue({ ...catalogue(), images: [accessor] }),
  );
  assert.throws(
    () =>
      publishedImageReference(
        catalogue(),
        "missing",
        "v1.0",
        "https://example.org/",
      ),
    /missing/,
  );
});

test("published references admit HTTP(S) only without authority surprises", () => {
  for (const url of [
    "file:///disk",
    "data:hi",
    "/disk",
    "https://user@example.org/disk",
    "https://example.org/disk#x",
    "https://example.org/disk#",
    " https://example.org/disk",
    "https://example.org/\ndisk",
  ]) {
    assert.throws(() =>
      validatePublishedImageReference({ ...reference(), url }),
    );
  }
  assert.equal(
    validatePublishedImageReference({
      ...reference(),
      url: "http://localhost/disk.img",
    }).url,
    "http://localhost/disk.img",
  );
  assert.throws(() =>
    validatePublishedImageReference({ ...reference(), asset: "disk.img" }),
  );
});

test("fetch validates complete body and captures descriptor before awaiting", async () => {
  const ref = reference();
  let release;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const pending = fetchPublishedImage(ref, {
    crypto: webcrypto,
    fetch: async (url, options) => {
      assert.equal(url, reference().url);
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      return response;
    },
  });
  ref.sha256 = "0".repeat(64);
  ref.byteLength = 8388608;
  release(
    new Response(bytes, {
      headers: { "content-length": String(bytes.length) },
    }),
  );
  const result = await pending;
  assert.deepEqual(result, bytes);
  result.fill(9);
  assert.equal(bytes[0], 7);
});

test("fetch rejects missing, short, changed, redirected and oversized streams", async () => {
  const read = (response) =>
    fetchPublishedImage(reference(), {
      crypto: webcrypto,
      fetch: async () => response,
    });
  for (const response of [
    new Response(null, { status: 404 }),
    new Response(null),
    new Response(bytes.subarray(1)),
    new Response(new Uint8Array(bytes.length)),
    new Response(bytes, { headers: { "content-length": "8388609" } }),
    new Response(bytes, { headers: { "content-length": "4, 4" } }),
    new Response(bytes, { headers: { "content-length": "1" } }),
  ]) {
    await assert.rejects(read(response));
  }
  await assert.rejects(read({ ok: true, redirected: true }), /redirect/);
  await assert.rejects(
    read({ ok: true, url: "https://other.example/image" }),
    /URL/,
  );
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(read(new Response(stream)), /length|bound/);
  assert(cancelled);
  let chunk = bytes.slice();
  const changing = new ReadableStream(
    {
      start(controller) {
        controller.enqueue(chunk);
      },
      pull(controller) {
        chunk.fill(0);
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  assert.deepEqual(await read(new Response(changing)), bytes);
});

test("maximum image and multi-chunk response limits are enforced before publication", async () => {
  const large = new Uint8Array(8388608).fill(1);
  const ref = {
    ...reference(),
    geometry: "triptych-cpm-8m-v1",
    byteLength: large.length,
    systemProfile: null,
    sha256: createHash("sha256").update(large).digest("hex"),
  };
  const response = (extra) =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(large.subarray(0, 4194304));
          controller.enqueue(large.subarray(4194304));
          if (extra) controller.enqueue(Uint8Array.of(2));
          controller.close();
        },
      }),
    );
  const received = await fetchPublishedImage(ref, {
    crypto: webcrypto,
    fetch: async () => response(false),
  });
  assert.deepEqual(received, large);
  await assert.rejects(
    fetchPublishedImage(ref, {
      crypto: webcrypto,
      fetch: async () => response(true),
    }),
    /bounds/,
  );
});
