import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";

const directory = resolve(process.argv[2] ?? "dist/wasm-browser");
const expectedRevision = process.argv[3];
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
  "terminal.js",
  "working-disk-store.js",
  "working-disk-persistence.js",
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
console.log(
  JSON.stringify({
    status: "passed",
    revision: manifest.distribution.triptych.revision,
    dirty: manifest.distribution.triptych.dirty,
    assets: names.size,
    diskSha256: manifest.distribution.disk.sha256,
  }),
);
