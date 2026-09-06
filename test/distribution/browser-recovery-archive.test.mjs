import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  archiveBrowserRecovery,
  verifyBrowserRecoveryArchive,
} from "../../tools/archive-browser-recovery.mjs";

const revision = "a".repeat(40);
const systemAsset = "system-triptych-cpm-8m-v1.bin";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let root, source, archive, manifest;
const options = () => ({
  sourceDirectory: source,
  archiveDirectory: archive,
  expectedRevision: revision,
});
const saveManifest = () =>
  writeFile(join(source, "deployment-manifest.json"), JSON.stringify(manifest));

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "triptych-recovery-archive-"));
  source = join(root, "source");
  archive = join(root, "archive");
  await mkdir(source);
  const disk = Buffer.alloc(256512, 0xe5);
  const bootstrap = Buffer.alloc(256, 0xc3);
  const largeSystem = Buffer.alloc(16384);
  disk.copy(largeSystem, 0, 0, 0x1600);
  largeSystem.fill(0x44, 0x1600, 0x1a00);
  const assets = new Map([
    ["bootstrap.bin", bootstrap],
    ["ccp.bin", disk.subarray(0, 0x800)],
    ["bdos.bin", disk.subarray(0x800, 0x1600)],
    ["bios.bin", disk.subarray(0x1600, 0x1a00)],
    ["cpm22.img", disk],
    [systemAsset, largeSystem],
  ]);
  for (const name of [
    "index.html",
    "app.js",
    "terminal.js",
    "style.css",
    "config.json",
    "working-disk-revisions.js",
    "disk-workspace.js",
    "disk-profile.js",
    "tool-catalog.js",
    "tool-catalog.json",
    "source-bundle.js",
    "adventure-IO.NU",
    "adventure-MAIN.NU",
    "adventure-BUILD.JSN",
    "working-disk-store.js",
    ".nojekyll",
    "triptych_host_wasm.js",
    "triptych_host_wasm_bg.wasm",
  ])
    assets.set(name, Buffer.from(`synthetic ${name}\n`));
  manifest = {
    schema: "triptych-browser-deployment-v1",
    distribution: {
      schema: "triptych-cpm-distribution-v1",
      triptych: { revision, dirty: false },
      disk: { bytes: disk.length, sha256: sha256(disk) },
      bootstrap: { bytes: bootstrap.length, sha256: sha256(bootstrap) },
    },
    diskProfiles: [
      {
        id: "triptych-cpm-8m-v1",
        residentProfile: "triptych-cpu-v0.1-8m-a",
        imageBytes: 8388608,
        systemBytes: 16384,
        drives: 1,
        systemAsset,
        bootstrapSha256: sha256(bootstrap),
        ccpSha256: sha256(disk.subarray(0, 0x800)),
        bdosSha256: sha256(disk.subarray(0x800, 0x1600)),
        bios: {
          source: "system/cpm/bios-8m.asm",
          sourceSha256: "b".repeat(64),
          sha256: sha256(largeSystem.subarray(0x1600, 0x1a00)),
        },
      },
    ],
    assets: [...assets].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
    })),
  };
  for (const [name, bytes] of assets)
    await writeFile(join(source, name), bytes);
  await saveManifest();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("exact browser recovery archive", () => {
  it("retains every exact served byte and external identity without claiming runtime proof", async () => {
    const receipt = await archiveBrowserRecovery(options());
    expect(receipt).toEqual({
      schema: "triptych-browser-recovery-archive-v1",
      sourceRevision: revision,
      sourceDirty: false,
      deploymentSchema: manifest.schema,
      deploymentManifestSha256: sha256(
        await readFile(join(source, "deployment-manifest.json")),
      ),
      assetCount: manifest.assets.length,
      intendedStorageSchema: "triptych-working-disk-v2",
      runtimeQualification: "not-performed",
    });
    expect((await readdir(archive)).sort()).toEqual([
      "recovery-archive.json",
      "site",
    ]);
    expect((await readdir(join(archive, "site"))).sort()).toEqual(
      (await readdir(source)).sort(),
    );
    for (const name of await readdir(source))
      expect(await readFile(join(archive, "site", name))).toEqual(
        await readFile(join(source, name)),
      );
    expect(await verifyBrowserRecoveryArchive(options())).toEqual(receipt);
  });

  it("never overwrites an existing archive, including an empty directory", async () => {
    await mkdir(archive);
    await expect(archiveBrowserRecovery(options())).rejects.toThrow(/EEXIST/);
    expect(await readdir(archive)).toEqual([]);
  });

  it("rejects development builds unless explicitly requested and preserves that identity", async () => {
    manifest.distribution.triptych.dirty = true;
    await saveManifest();
    await expect(archiveBrowserRecovery(options())).rejects.toThrow(
      /development build/,
    );
    expect(await readdir(root)).toEqual(["source"]);
    const receipt = await archiveBrowserRecovery({
      ...options(),
      allowDevelopment: true,
    });
    expect(receipt.sourceDirty).toBe(true);
    await expect(verifyBrowserRecoveryArchive(options())).rejects.toThrow(
      /development build/,
    );
  });

  it("rejects revision mismatch, unsafe manifest paths and unlisted files before reservation", async () => {
    await expect(
      archiveBrowserRecovery({
        ...options(),
        expectedRevision: "b".repeat(40),
      }),
    ).rejects.toThrow(/source revision/);
    const path = manifest.assets[0].path;
    manifest.assets[0].path = "../secret";
    await saveManifest();
    await expect(archiveBrowserRecovery(options())).rejects.toThrow(
      /unsafe asset basename/,
    );
    manifest.assets[0].path = path;
    await saveManifest();
    await writeFile(join(source, "unlisted"), "unexpected");
    await expect(archiveBrowserRecovery(options())).rejects.toThrow(
      /unlisted deployment files/,
    );
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("rejects symlink assets even when their bytes and manifest hash agree", async () => {
    const bytes = await readFile(join(source, "app.js"));
    const outside = join(root, "outside.js");
    await writeFile(outside, bytes);
    await rm(join(source, "app.js"));
    await symlink(outside, join(source, "app.js"));
    await expect(archiveBrowserRecovery(options())).rejects.toThrow(
      /regular file/,
    );
  });

  it("rejects archives within the source, including a symlinked parent alias", async () => {
    await expect(
      archiveBrowserRecovery({
        ...options(),
        archiveDirectory: join(source, "nested"),
      }),
    ).rejects.toThrow(/outside the source/);
    const alias = join(root, "alias");
    await symlink(source, alias);
    await expect(
      archiveBrowserRecovery({
        ...options(),
        archiveDirectory: join(alias, "nested"),
      }),
    ).rejects.toThrow(/outside the source/);
    expect(await readdir(source)).not.toContain("nested");
  });

  it("rejects tampered archived bytes and an invented compatibility claim", async () => {
    await archiveBrowserRecovery(options());
    const path = join(archive, "site", "app.js");
    const original = await readFile(path);
    await writeFile(path, Buffer.alloc(original.length));
    await expect(verifyBrowserRecoveryArchive(options())).rejects.toThrow(
      /app.js digest/,
    );
    await writeFile(path, original);
    const metadata = join(archive, "recovery-archive.json");
    const receipt = JSON.parse(await readFile(metadata, "utf8"));
    receipt.runtimeQualification = "passed";
    await writeFile(metadata, JSON.stringify(receipt));
    await expect(verifyBrowserRecoveryArchive(options())).rejects.toThrow(
      /metadata differs/,
    );
  });

  it("checks resident slots, not only a self-consistent asset hash", async () => {
    const bytes = await readFile(join(source, "ccp.bin"));
    bytes[0] ^= 1;
    await writeFile(join(source, "ccp.bin"), bytes);
    manifest.assets.find((asset) => asset.path === "ccp.bin").sha256 =
      sha256(bytes);
    await saveManifest();
    await expect(archiveBrowserRecovery(options())).rejects.toThrow(
      /ccp.bin differs/,
    );
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("rejects a nonzero large-system tail before reserving an archive", async () => {
    const bytes = await readFile(join(source, systemAsset));
    bytes[0x1a00] = 1;
    await writeFile(join(source, systemAsset), bytes);
    manifest.assets.find((asset) => asset.path === systemAsset).sha256 =
      sha256(bytes);
    await saveManifest();
    await expect(archiveBrowserRecovery(options())).rejects.toThrow(
      /large system reserved tail must be zero/,
    );
    expect(await readdir(root)).toEqual(["source"]);
  });

  it("provides a create/verify CLI and rejects an incomplete archive", async () => {
    const helper = resolve(
      import.meta.dirname,
      "../../tools/archive-browser-recovery.mjs",
    );
    for (const args of [
      ["create", source, archive, revision],
      ["verify", archive, revision],
    ]) {
      const result = spawnSync(process.execPath, [helper, ...args], {
        encoding: "utf8",
        timeout: 15_000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).runtimeQualification).toBe(
        "not-performed",
      );
    }
    await rm(join(archive, "recovery-archive.json"));
    await expect(verifyBrowserRecoveryArchive(options())).rejects.toThrow(
      /ENOENT/,
    );
  });
});
