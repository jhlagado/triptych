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
const systemAsset = "system-triptych-cpm-8m-v1.bin";
const abSystemAsset = "system-triptych-cpm-8m-ab-v1.bin";
const abBootstrapAsset = "bootstrap-triptych-cpm-8m-ab-v1.bin";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
let directory;
let manifest;

async function saveManifest() {
  await writeFile(
    join(directory, "deployment-manifest.json"),
    JSON.stringify(manifest),
  );
}

async function replaceAsset(name, bytes) {
  await writeFile(join(directory, name), bytes);
  const asset = manifest.assets.find((entry) => entry.path === name);
  asset.bytes = bytes.length;
  asset.sha256 = sha256(bytes);
  await saveManifest();
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
  const largeSystem = Buffer.alloc(16384);
  disk.copy(largeSystem, 0, 0, 0x1600);
  largeSystem.fill(0x44, 0x1600, 0x1a00);
  const abSystem = Buffer.alloc(16384);
  abSystem.fill(0x55, 0, 0x800);
  abSystem.fill(0x66, 0x800, 0x1600);
  abSystem.fill(0x77, 0x1600, 0x1900);
  const abBootstrap = Buffer.alloc(256, 0x88);
  // Synthetic bytes exercise deployment identity and drive roles, not CP/M
  // execution or filesystem contents (the real distribution suite covers those).
  const publicA = Buffer.alloc(8388608, 0xe5);
  abSystem.copy(publicA);
  const publicB = Buffer.alloc(8388608, 0xe5);
  publicB.fill(0, 0, 16384);
  const assets = new Map([
    ["bootstrap.bin", bootstrap],
    ["ccp.bin", disk.subarray(0, 0x800)],
    ["bdos.bin", disk.subarray(0x800, 0x1600)],
    ["bios.bin", disk.subarray(0x1600, 0x1a00)],
    ["cpm22.img", disk],
    [systemAsset, largeSystem],
    [abSystemAsset, abSystem],
    [abBootstrapAsset, abBootstrap],
    ["drive-a-system.img", publicA],
    ["drive-b-games.img", publicB],
  ]);
  for (const name of [
    "index.html",
    "app.js",
    "public-distribution.js",
    "terminal.js",
    "style.css",
    "config.json",
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
    "working-disk-store.js",
    ".nojekyll",
    "triptych_host_wasm.js",
    "triptych_host_wasm_bg.wasm",
    "triptych_host_wasm.d.ts",
    "triptych_host_wasm_bg.wasm.d.ts",
  ]) {
    assets.set(name, Buffer.from(`synthetic ${name}\n`));
  }
  assets.set(
    "config.json",
    Buffer.from(
      JSON.stringify({
        diskUrl: "cpm22.img",
        diskName: "triptych-cpm22.img",
        systemCcp: "triptych",
        publicDrives: true,
      }),
    ),
  );
  expect(assets.size).toBe(33);
  manifest = {
    schema: "triptych-browser-deployment-v1",
    distribution: {
      schema: "triptych-cpm-distribution-v1",
      triptych: { revision, dirty: false },
      targetProfile: "triptych-cpu-v0.1",
      disk: { bytes: disk.length, sha256: sha256(disk) },
      bootstrap: { bytes: bootstrap.length, sha256: sha256(bootstrap) },
    },
    publicDrives: {
      schema: "triptych-public-drives-v1",
      profile: "triptych-cpu-v0.1-8m-ab",
      bootstrapAsset: abBootstrapAsset,
      drives: Object.fromEntries(
        [
          ["A", "drive-a-system.img", publicA],
          ["B", "drive-b-games.img", publicB],
        ].map(([letter, path, bytes]) => [
          letter,
          {
            path,
            name: path,
            bytes: bytes.length,
            sha256: sha256(bytes),
          },
        ]),
      ),
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
      {
        id: "triptych-cpm-8m-v1",
        residentProfile: "triptych-cpu-v0.1-8m-ab",
        imageBytes: 8388608,
        systemBytes: 16384,
        drives: 2,
        systemAsset: abSystemAsset,
        systemSha256: sha256(abSystem),
        bootstrapAsset: abBootstrapAsset,
        bootstrapSha256: sha256(abBootstrap),
        residentLockSha256: "c".repeat(64),
        ccpSha256: sha256(abSystem.subarray(0, 0x800)),
        bdosSha256: sha256(abSystem.subarray(0x800, 0x1600)),
        bios: {
          source: "system/cpm/bios-8m-ab.asm",
          sourceSha256: "d".repeat(64),
          sha256: sha256(abSystem.subarray(0x1600, 0x1a00)),
          liveEnd: 0xfc00,
        },
      },
    ],
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
      assets: 33,
      diskSha256: manifest.distribution.disk.sha256,
    });
  });

  it("rejects a missing public-drive descriptor", async () => {
    delete manifest.publicDrives;
    await saveManifest();
    rejected(check(), "missing or unsupported public distribution");
  });

  it.each([undefined, false, "true"])(
    "rejects a new-visitor publicDrives config value of %s",
    async (publicDrives) => {
      await replaceAsset(
        "config.json",
        Buffer.from(
          JSON.stringify({
            diskUrl: "cpm22.img",
            publicDrives,
          }),
        ),
      );
      rejected(check(), "new visitors must receive the public A/B pair");
    },
  );

  it.each(["A", "B"])(
    "rejects mixed public %s image identity despite consistent asset bytes",
    async (letter) => {
      const entry = manifest.publicDrives.drives[letter];
      const bytes = await readFile(join(directory, entry.path));
      bytes[16384] ^= 1;
      await replaceAsset(entry.path, bytes);
      rejected(check(), `invalid ${letter}: image identity`);
    },
  );

  it.each(["A", "B"])(
    "rejects incorrect public %s system area even with both hashes updated",
    async (letter) => {
      const entry = manifest.publicDrives.drives[letter];
      const bytes = await readFile(join(directory, entry.path));
      bytes[0] ^= 1;
      entry.sha256 = sha256(bytes);
      await replaceAsset(entry.path, bytes);
      rejected(check(), `${letter}: system area differs from its role`);
    },
  );

  it("rejects missing large-disk metadata in a new deployment", async () => {
    delete manifest.diskProfiles;
    await saveManifest();
    rejected(check(), "two supported disk profiles");
  });

  it.each([
    ["empty array", []],
    ["null", null],
    ["object", {}],
  ])("rejects invalid profile metadata: %s", async (_label, profiles) => {
    manifest.diskProfiles = profiles;
    await saveManifest();
    rejected(check(), "two supported disk profiles");
  });

  it("rejects a duplicate valid profile descriptor", async () => {
    manifest.diskProfiles.push(structuredClone(manifest.diskProfiles[0]));
    await saveManifest();
    rejected(check(), "two supported disk profiles");
  });

  it.each([
    ["id", "ibm3740"],
    ["residentProfile", "triptych-cpu-v0.1"],
    ["imageBytes", 8388607],
    ["systemBytes", 16383],
    ["drives", 2],
    ["systemAsset", "../outside.bin"],
  ])("rejects a changed profile %s", async (field, value) => {
    manifest.diskProfiles[0][field] = value;
    await saveManifest();
    rejected(check(), `disk profile ${field}`);
  });

  it("rejects missing and unknown descriptor fields", async () => {
    delete manifest.diskProfiles[0].drives;
    await saveManifest();
    rejected(check(), "disk profile fields");
    manifest.diskProfiles[0].drives = 1;
    manifest.diskProfiles[0].extra = true;
    await saveManifest();
    rejected(check(), "disk profile fields");
  });

  it("rejects missing BIOS metadata and altered source paths", async () => {
    const bios = manifest.diskProfiles[0].bios;
    manifest.diskProfiles[0].bios = null;
    await saveManifest();
    rejected(check(), "disk profile BIOS");
    manifest.diskProfiles[0].bios = { ...bios, source: "system/cpm/bios.asm" };
    await saveManifest();
    rejected(check(), "disk profile BIOS source");
  });

  it("rejects missing and unknown BIOS fields", async () => {
    delete manifest.diskProfiles[0].bios.sourceSha256;
    await saveManifest();
    rejected(check(), "disk profile BIOS fields");
    manifest.diskProfiles[0].bios.sourceSha256 = "b".repeat(64);
    manifest.diskProfiles[0].bios.extra = true;
    await saveManifest();
    rejected(check(), "disk profile BIOS fields");
  });

  it.each(["bootstrapSha256", "ccpSha256", "bdosSha256"])(
    "rejects malformed and incorrect %s",
    async (field) => {
      manifest.diskProfiles[0][field] = "bad";
      await saveManifest();
      rejected(check(), `disk profile ${field} syntax`);
      manifest.diskProfiles[0][field] = "0".repeat(64);
      await saveManifest();
      rejected(check(), "identity");
    },
  );

  it.each(["sha256", "sourceSha256"])(
    "rejects malformed BIOS %s",
    async (field) => {
      manifest.diskProfiles[0].bios[field] = "BAD";
      await saveManifest();
      rejected(check(), "syntax");
    },
  );

  it("rejects a wrong BIOS digest even if the asset list is intact", async () => {
    manifest.diskProfiles[0].bios.sha256 = "0".repeat(64);
    await saveManifest();
    rejected(check(), "large system BIOS identity");
  });

  it.each([
    [0, "large system ccp.bin slot"],
    [0x800, "large system bdos.bin slot"],
    [0x1600, "large system BIOS identity"],
    [0x1a00, "large system reserved tail must be zero"],
    [0x3fff, "large system reserved tail must be zero"],
  ])(
    "rejects changed system byte %i even with an updated asset digest",
    async (offset, diagnostic) => {
      const bytes = await readFile(join(directory, systemAsset));
      bytes[offset] ^= 1;
      await replaceAsset(systemAsset, bytes);
      rejected(check(), diagnostic);
    },
  );

  it.each([16383, 16385])(
    "rejects system length %i even with updated asset metadata",
    async (length) => {
      const bytes = Buffer.alloc(length);
      (await readFile(join(directory, systemAsset))).copy(bytes);
      await replaceAsset(systemAsset, bytes);
      rejected(check(), "large system asset length");
    },
  );

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
    "public-distribution.js",
    "drive-a-system.img",
    "drive-b-games.img",
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
    systemAsset,
    abSystemAsset,
    abBootstrapAsset,
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

  it("accepts reversed profile order without treating geometry IDs as unique", async () => {
    manifest.diskProfiles.reverse();
    await saveManifest();
    const result = check();
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["extra", true, "A/B disk profile fields"],
    ["drives", 1, "unsupported A/B resident profile"],
    ["bootstrapAsset", "bootstrap.bin", "unsupported A/B resident profile"],
    ["systemSha256", "0".repeat(64), "A/B asset identity mismatch"],
    ["residentLockSha256", "BAD", "unsupported A/B resident profile"],
    ["ccpSha256", "0".repeat(64), "A/B resident slots"],
  ])("rejects changed A/B profile %s", async (field, value, diagnostic) => {
    manifest.diskProfiles[1][field] = value;
    await saveManifest();
    rejected(check(), diagnostic);
  });

  it.each([0, 0x800, 0x1600, 0x1900, 0x3fff])(
    "rejects A/B slot/padding corruption at %i with updated complete identity",
    async (offset) => {
      const bytes = await readFile(join(directory, abSystemAsset));
      bytes[offset] ^= 1;
      manifest.diskProfiles[1].systemSha256 = sha256(bytes);
      if (offset === 0x1900) {
        manifest.diskProfiles[1].bios.sha256 = sha256(
          bytes.subarray(0x1600, 0x1a00),
        );
      }
      await replaceAsset(abSystemAsset, bytes);
      rejected(check(), "A/B resident slots or reserved bytes");
    },
  );

  it("rejects an independently changed A/B bootstrap even with rehashed asset metadata", async () => {
    const bytes = await readFile(join(directory, abBootstrapAsset));
    bytes[0] ^= 1;
    await replaceAsset(abBootstrapAsset, bytes);
    rejected(check(), "A/B asset identity mismatch");
  });
});
