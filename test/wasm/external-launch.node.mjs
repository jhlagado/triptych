import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { createHash, webcrypto } from "node:crypto";
import { loadExternalLaunch } from "../../crates/triptych-host-wasm/web/external-launch.js";
const root = new URL("../../distribution/disk-library/", import.meta.url);
const registry = JSON.parse(
  await readFile(new URL("disk-library-registry.json", root)),
);
const recipe = registry.recipes.find((row) => row.id === "skate");
const admission = registry.admissions.find(
  (row) => row.id === recipe.admission,
);
const deployment = JSON.parse(
  await readFile(new URL(admission.envelope, root)),
);
const image = registry.images.find((row) => row.id === "skate-0.5.1");
const original = new Uint8Array(await readFile(new URL(image.asset, root)));
const descriptor = {
  schema: "triptych-external-system-v1",
  name: "Skate",
  instruction: "Type B:",
  profile: image.systemProfile,
  image: { asset: "skate.img", bytes: original.length, sha256: image.sha256 },
  workDisk: "copy-image",
};
async function run({
  metadata = descriptor,
  disk = original,
  url = "https://publisher.example/release/system.json",
} = {}) {
  return loadExternalLaunch({
    url,
    deployment,
    baseUrl: "https://machine.example/",
    crypto: webcrypto,
    fetch: async (url, options) => {
      const target = new URL(url);
      if (target.hostname === "publisher.example") {
        assert.equal(options.credentials, "omit");
        return new Response(
          target.pathname.endsWith("system.json")
            ? JSON.stringify(metadata)
            : disk,
        );
      }
      assert.equal(target.hostname, "machine.example");
      const binding = admission.bindings.find(
        (row) => row.path === target.pathname.slice(1),
      );
      assert(binding, target.href);
      return new Response(await readFile(new URL(binding.asset, root)));
    },
  });
}
test("external image loads with Triptych bootstrap and a work-disk seed", async () => {
  const launch = await run();
  assert.deepEqual(launch.image, original);
  assert.equal(launch.configuredCount, 4);
  assert.equal(launch.seedWorkDisk, true);
  assert.equal(launch.bootstrap.length, 256);
});
test("corrupt download fails its checksum", async () => {
  const disk = original.slice();
  disk[20000] ^= 1;
  await assert.rejects(run({ disk }), /verification failed/);
});
test("valid checksum cannot admit incompatible residents", async () => {
  const disk = original.slice();
  disk[1] ^= 1;
  const metadata = structuredClone(descriptor);
  metadata.image.sha256 = createHash("sha256").update(disk).digest("hex");
  await assert.rejects(run({ disk, metadata }), /residents are incompatible/);
});
test("external metadata is bounded and cannot redirect image loading", async () => {
  await assert.rejects(
    run({ url: "http://publisher.example/system.json" }),
    /HTTPS/,
  );
  const metadata = structuredClone(descriptor);
  metadata.image.asset = "../elsewhere.img";
  await assert.rejects(run({ metadata }), /invalid image/);
  await assert.rejects(
    run({ metadata: { padding: "x".repeat(17000) } }),
    /exceeds 16 KiB/,
  );
});
