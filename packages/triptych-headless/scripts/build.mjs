#!/usr/bin/env node

// Assemble the publishable package in dist/:
//   dist/wasm/      the Node build of crates/triptych-host-wasm
//   dist/boot.bin   the 2 MB N04 boot ROM from the disk library
//   dist/system.bin the 2 MB N04 system area from the disk library
//   dist/manifest.json  the source revision and every file's SHA-256
//
// The boot ROM and system area are committed, content-addressed files, so the
// package always carries the exact resident system the browser ships.
//
//   --reuse-wasm  copy the repository's existing dist/wasm instead of
//                 rebuilding it (needs a recent `npm run build:wasm-host`)
//   --check       verify an existing dist/ instead of writing one, and refuse
//                 a build made from a dirty working tree

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const distRoot = join(packageRoot, "dist");
const check = process.argv.includes("--check");
const reuseWasm = process.argv.includes("--reuse-wasm");

export const SYSTEM_PROFILE = "triptych-cpu-v0.1-2m-n04";
const BOOT_SHA256 = "54c6bfd356b4b42f8c51f3b85777a9d2be7aa680945335783c4dd7a6dae8921e";
const SYSTEM_SHA256 = "61dd21e3f89be888e3530ec3b414691c343f7ad2c29aa15fac4ff2510c3a5a3e";
const WASM_FILES = [
  "triptych_host_wasm.js",
  "triptych_host_wasm.d.ts",
  "triptych_host_wasm_bg.wasm",
  "triptych_host_wasm_bg.wasm.d.ts",
  "package.json",
];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (...args) => execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();

async function libraryAsset(sha) {
  const bytes = await readFile(join(repositoryRoot, "distribution/disk-library", `library-retained-${sha}.bin`));
  assert.equal(sha256(bytes), sha, `disk-library asset ${sha} does not match its name`);
  return bytes;
}

async function manifestFor() {
  const files = {};
  for (const name of WASM_FILES) {
    files[`wasm/${name}`] = sha256(await readFile(join(distRoot, "wasm", name)));
  }
  for (const name of ["boot.bin", "system.bin"]) {
    files[name] = sha256(await readFile(join(distRoot, name)));
  }
  return files;
}

if (check) {
  const manifest = JSON.parse(await readFile(join(distRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.profile, SYSTEM_PROFILE);
  assert.equal(manifest.dirty, false, "dist/ was built from a dirty working tree");
  assert.deepEqual(manifest.files, await manifestFor(), "dist/ does not match its manifest");
  assert.equal(manifest.files["boot.bin"], BOOT_SHA256);
  assert.equal(manifest.files["system.bin"], SYSTEM_SHA256);
  console.log(`dist/ verified: ${SYSTEM_PROFILE} from ${manifest.revision}.`);
} else {
  if (!reuseWasm) {
    execFileSync(process.execPath, ["tools/build-wasm-host.mjs"], { cwd: repositoryRoot, stdio: "inherit" });
  }
  await rm(distRoot, { recursive: true, force: true });
  await mkdir(join(distRoot, "wasm"), { recursive: true });
  const built = await readdir(join(repositoryRoot, "dist/wasm"));
  for (const name of WASM_FILES) {
    assert.ok(built.includes(name), `dist/wasm/${name} is missing: run npm run build:wasm-host`);
    await copyFile(join(repositoryRoot, "dist/wasm", name), join(distRoot, "wasm", name));
  }
  await writeFile(join(distRoot, "boot.bin"), await libraryAsset(BOOT_SHA256));
  await writeFile(join(distRoot, "system.bin"), await libraryAsset(SYSTEM_SHA256));
  for (const name of ["LICENSE", "NOTICE.md"]) {
    await copyFile(join(repositoryRoot, name), join(packageRoot, name));
  }
  const manifest = {
    schema: "triptych-headless-manifest-v1",
    profile: SYSTEM_PROFILE,
    revision: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain").length > 0,
    files: await manifestFor(),
  };
  await writeFile(join(distRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`dist/ written for ${SYSTEM_PROFILE} from ${manifest.revision}${manifest.dirty ? " (dirty tree)" : ""}.`);
}
