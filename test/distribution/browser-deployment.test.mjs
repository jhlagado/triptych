import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const checker = resolve(
  import.meta.dirname,
  "../../tools/check-browser-deployment.mjs",
);
const revision = "a".repeat(40);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let directory;
let manifest;

async function saveManifest() {
  await writeFile(
    join(directory, "deployment-manifest.json"),
    JSON.stringify(manifest),
  );
}

function check(expectedRevision = revision, release = true) {
  return spawnSync(
    process.execPath,
    [checker, directory, expectedRevision, ...(release ? ["--release"] : [])],
    { encoding: "utf8", timeout: 10_000 },
  );
}

function rejected(result, diagnostic) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(diagnostic);
  expect(result.stdout).not.toContain('"status":"passed"');
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "triptych-browser-deployment-"));
  const disk = Buffer.alloc(256512, 0xe5);
  disk.fill(0x11, 0, 0x800);
  disk.fill(0x22, 0x800, 0x1600);
  disk.fill(0x33, 0x1600, 0x1a00);
  const bootstrap = Buffer.alloc(256, 0xc3);
  const assets = new Map([
    ["bootstrap.bin", bootstrap],
    ["ccp.bin", disk.subarray(0, 0x800)],
    ["bdos.bin", disk.subarray(0x800, 0x1600)],
    ["bios.bin", disk.subarray(0x1600, 0x1a00)],
    ["cpm22.img", disk],
  ]);
  for (const name of [
    "index.html",
    "app.js",
    "terminal.js",
    "style.css",
    "config.json",
    "working-disk-persistence.js",
    "working-disk-store.js",
    ".nojekyll",
    "triptych_host_wasm.js",
    "triptych_host_wasm_bg.wasm",
    "triptych_host_wasm.d.ts",
    "triptych_host_wasm_bg.wasm.d.ts",
  ]) {
    assets.set(name, Buffer.from(`synthetic ${name}\n`));
  }
  expect(assets.size).toBe(17);
  manifest = {
    schema: "triptych-browser-deployment-v1",
    distribution: {
      schema: "triptych-cpm-distribution-v1",
      triptych: { revision, dirty: false },
      targetProfile: "triptych-cpu-v0.1",
      disk: { bytes: disk.length, sha256: sha256(disk) },
      bootstrap: { bytes: bootstrap.length, sha256: sha256(bootstrap) },
    },
    assets: [...assets].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  await Promise.all(
    [...assets].map(([path, bytes]) => writeFile(join(directory, path), bytes)),
  );
  await saveManifest();
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("browser deployment verification CLI", () => {
  it("accepts a consistent private deployment with the expected source revision", () => {
    const result = check();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      status: "passed",
      revision,
      dirty: false,
      assets: 17,
      diskSha256: manifest.distribution.disk.sha256,
    });
  });

  it("rejects an asset with changed bytes and unchanged length", async () => {
    const path = join(directory, "app.js");
    const bytes = await readFile(path);
    bytes[0] ^= 1;
    await writeFile(path, bytes);
    rejected(check(), "app.js digest");
  });

  it("rejects an unlisted deployment file", async () => {
    await writeFile(join(directory, "stale.js"), "stale");
    rejected(check(), "unlisted deployment files");
  });

  it.each([
    "working-disk-store.js",
    "working-disk-persistence.js",
    ".nojekyll",
  ])(
    "rejects omitted required %s even when it is removed from the manifest",
    async (name) => {
      await rm(join(directory, name));
      manifest.assets = manifest.assets.filter((asset) => asset.path !== name);
      await saveManifest();
      rejected(check(), `missing required asset ${name}`);
    },
  );

  it("rejects a duplicate asset path", async () => {
    manifest.assets.push({ ...manifest.assets[0] });
    await saveManifest();
    rejected(check(), "duplicate deployment asset");
  });

  it("rejects a traversal path before trying to read it", async () => {
    manifest.assets[0].path = "../outside.bin";
    await saveManifest();
    rejected(check(), "asset basename");
  });

  it("rejects a deployment from a different source revision", () => {
    rejected(check("b".repeat(40)), "deployment source revision");
  });

  it("rejects dirty release media while permitting an explicit development check", async () => {
    manifest.distribution.triptych.dirty = true;
    await saveManifest();
    rejected(check(), "deployment is a development build");
    const development = check(revision, false);
    expect(development.status, development.stderr).toBe(0);
    expect(JSON.parse(development.stdout).dirty).toBe(true);
  });

  it("rejects a resident that disagrees with its disk slot even when its asset digest is updated", async () => {
    const path = join(directory, "ccp.bin");
    const bytes = await readFile(path);
    bytes[0] ^= 1;
    await writeFile(path, bytes);
    manifest.assets.find((asset) => asset.path === "ccp.bin").sha256 =
      sha256(bytes);
    await saveManifest();
    rejected(check(), "ccp.bin differs from distribution slot");
  });
});
