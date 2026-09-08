import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { webcrypto } from "node:crypto";
import { fetchLargeAbDiskSystem } from "../crates/triptych-host-wasm/web/disk-profile.js";
import { fetchPublicDriveSet } from "../crates/triptych-host-wasm/web/public-distribution.js";

const directory = resolve(process.argv[2] ?? "dist/wasm-browser");
const expectedRevision = process.argv[3];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const systemAsset = "system-triptych-cpm-8m-v1.bin";
const manifest = JSON.parse(
  await readFile(join(directory, "deployment-manifest.json"), "utf8"),
);
assert.equal(manifest.schema, "triptych-browser-deployment-v1");
assert.equal(manifest.distribution.schema, "triptych-cpm-distribution-v1");
if (expectedRevision && !expectedRevision.startsWith("--")) {
  assert.equal(
    manifest.distribution.triptych.revision,
    expectedRevision,
    "deployment source revision",
  );
}
if (process.argv.includes("--release")) {
  assert.equal(
    manifest.distribution.triptych.dirty,
    false,
    "deployment is a development build",
  );
}
assert.ok(Array.isArray(manifest.assets) && manifest.assets.length > 0);
const names = new Set();
for (const asset of manifest.assets) {
  assert.match(asset.path, /^[A-Za-z0-9_.-]+$/, "asset basename");
  assert.ok(
    asset.path !== "." &&
      asset.path !== ".." &&
      asset.path !== "deployment-manifest.json",
  );
  assert.ok(!names.has(asset.path), "duplicate deployment asset");
  names.add(asset.path);
  const bytes = await readFile(join(directory, asset.path));
  assert.equal(bytes.length, asset.bytes, `${asset.path} length`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    asset.sha256,
    `${asset.path} digest`,
  );
}
assert.deepEqual(
  [...names].sort(),
  (await readdir(directory))
    .filter((name) => name !== "deployment-manifest.json")
    .sort(),
  "unlisted deployment files",
);
for (const name of [
  "index.html",
  "app.js",
  "public-distribution.js",
  "drive-a-system.img",
  "drive-b-games.img",
  "terminal.js",
  "working-disk-store.js",
  "working-disk-revisions.js",
  "disk-workspace.js",
  "disk-profile.js",
  "drive-set.js",
  "drive-set-store.js",
  "tool-catalog.js",
  "tool-catalog.json",
  "source-bundle.js",
  "adventure-IO.NU",
  "adventure-MAIN.NU",
  "adventure-BUILD.JSN",
  ".nojekyll",
  "style.css",
  "config.json",
  "triptych_host_wasm.js",
  "triptych_host_wasm_bg.wasm",
  "bootstrap.bin",
  "ccp.bin",
  "bdos.bin",
  "bios.bin",
  "cpm22.img",
  systemAsset,
  "system-triptych-cpm-8m-ab-v1.bin",
  "bootstrap-triptych-cpm-8m-ab-v1.bin",
]) {
  assert.ok(names.has(name), `missing required asset ${name}`);
}
const disk = await readFile(join(directory, "cpm22.img"));
assert.equal(disk.length, manifest.distribution.disk.bytes);
assert.equal(disk.length, 256512);
assert.equal(
  createHash("sha256").update(disk).digest("hex"),
  manifest.distribution.disk.sha256,
);
for (const [file, first, end] of [
  ["ccp.bin", 0, 0x800],
  ["bdos.bin", 0x800, 0x1600],
  ["bios.bin", 0x1600, 0x1a00],
]) {
  assert.deepEqual(
    await readFile(join(directory, file)),
    disk.subarray(first, end),
    `${file} differs from distribution slot`,
  );
}
const boot = await readFile(join(directory, "bootstrap.bin"));
assert.equal(boot.length, manifest.distribution.bootstrap.bytes);
assert.equal(
  createHash("sha256").update(boot).digest("hex"),
  manifest.distribution.bootstrap.sha256,
);
// This verifier targets new builds. Qualify pre-profile archived deployments
// with their release's verification contract, not inferred new metadata.
assert.ok(
  Array.isArray(manifest.diskProfiles) && manifest.diskProfiles.length === 2,
  "two supported disk profiles are required",
);
const profile = manifest.diskProfiles.find(
  (entry) => entry?.residentProfile === "triptych-cpu-v0.1-8m-a",
);
assert.ok(profile, "disk profile residentProfile");
assert.ok(profile && typeof profile === "object", "disk profile object");
assert.deepEqual(
  Object.keys(profile).sort(),
  [
    "id",
    "residentProfile",
    "imageBytes",
    "systemBytes",
    "drives",
    "systemAsset",
    "bootstrapSha256",
    "ccpSha256",
    "bdosSha256",
    "bios",
  ].sort(),
  "disk profile fields",
);
for (const [field, value] of Object.entries({
  id: "triptych-cpm-8m-v1",
  residentProfile: "triptych-cpu-v0.1-8m-a",
  imageBytes: 8388608,
  systemBytes: 16384,
  drives: 1,
  systemAsset,
})) {
  assert.equal(profile[field], value, `disk profile ${field}`);
}
assert.ok(
  profile.bios && typeof profile.bios === "object",
  "disk profile BIOS",
);
assert.deepEqual(
  Object.keys(profile.bios).sort(),
  ["source", "sourceSha256", "sha256"].sort(),
  "disk profile BIOS fields",
);
assert.equal(
  profile.bios.source,
  "system/cpm/bios-8m.asm",
  "disk profile BIOS source",
);
for (const [field, value] of Object.entries({
  bootstrapSha256: profile.bootstrapSha256,
  ccpSha256: profile.ccpSha256,
  bdosSha256: profile.bdosSha256,
  biosSha256: profile.bios.sha256,
  biosSourceSha256: profile.bios.sourceSha256,
})) {
  assert.match(value, /^[0-9a-f]{64}$/, `disk profile ${field} syntax`);
}
assert.equal(
  profile.bootstrapSha256,
  sha256(boot),
  "disk profile bootstrap identity",
);
const system = await readFile(join(directory, systemAsset));
assert.equal(system.length, 16384, "large system asset length");
for (const [file, first, end, digest] of [
  ["ccp.bin", 0, 0x800, profile.ccpSha256],
  ["bdos.bin", 0x800, 0x1600, profile.bdosSha256],
]) {
  const resident = await readFile(join(directory, file));
  assert.equal(digest, sha256(resident), `disk profile ${file} identity`);
  assert.deepEqual(
    system.subarray(first, end),
    resident,
    `large system ${file} slot`,
  );
}
assert.equal(
  sha256(system.subarray(0x1600, 0x1a00)),
  profile.bios.sha256,
  "large system BIOS identity",
);
assert.ok(
  system.subarray(0x1a00).every((byte) => byte === 0),
  "large system reserved tail must be zero",
);
// The browser and offline checker share the closed A/B descriptor, asset and
// slot checks. This intentionally does not compare E300 residents to E400 ones.
await fetchLargeAbDiskSystem({
  deployment: manifest,
  baseUrl: "https://deployment.invalid/",
  crypto: webcrypto,
  fetch: async (url) => {
    const bytes = await readFile(
      join(directory, new URL(url).pathname.slice(1)),
    );
    return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  },
});
assert.equal(
  JSON.parse(await readFile(join(directory, "config.json"), "utf8"))
    .publicDrives,
  true,
  "new visitors must receive the public A/B pair",
);
await fetchPublicDriveSet({
  deployment: manifest,
  baseUrl: "https://deployment.invalid/",
  crypto: webcrypto,
  fetch: async (url) => {
    const bytes = await readFile(
      join(directory, new URL(url).pathname.slice(1)),
    );
    return { ok: true, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
  },
});
console.log(
  JSON.stringify({
    status: "passed",
    revision: manifest.distribution.triptych.revision,
    dirty: manifest.distribution.triptych.dirty,
    assets: names.size,
    diskSha256: manifest.distribution.disk.sha256,
  }),
);
