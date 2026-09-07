import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const checker = fileURLToPath(
  new URL("./check-browser-deployment.mjs", import.meta.url),
);
const METADATA = "recovery-archive.json";
const MANIFEST = "deployment-manifest.json";
const SCHEMA = "triptych-browser-recovery-archive-v1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function regularBytes(path) {
  assert.ok((await lstat(path)).isFile(), `${path} must be a regular file`);
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    assert.ok((await file.stat()).isFile(), `${path} must be a regular file`);
    return await file.readFile();
  } finally {
    await file.close();
  }
}

async function snapshot(directory, expectedRevision, allowDevelopment) {
  assert.match(
    expectedRevision,
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    "expected source revision",
  );
  assert.ok(
    (await lstat(directory)).isDirectory(),
    "deployment must be a real directory",
  );
  const manifestBytes = await regularBytes(join(directory, MANIFEST));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  assert.equal(manifest.schema, "triptych-browser-deployment-v1");
  const storageSchema =
    manifest.storageSchema === undefined
      ? "triptych-drive-set-v3"
      : manifest.storageSchema;
  assert.ok(
    ["triptych-drive-set-v3", "triptych-drive-set-v4"].includes(storageSchema),
    "unrecognized deployment storage schema",
  );
  assert.equal(
    manifest.distribution?.triptych?.revision,
    expectedRevision,
    "deployment source revision",
  );
  assert.equal(
    typeof manifest.distribution.triptych.dirty,
    "boolean",
    "source cleanliness must be explicit",
  );
  if (!allowDevelopment)
    assert.equal(
      manifest.distribution.triptych.dirty,
      false,
      "development build cannot qualify as a release archive",
    );
  assert.ok(
    Array.isArray(manifest.assets) && manifest.assets.length > 0,
    "deployment assets required",
  );
  const files = new Map([[MANIFEST, manifestBytes]]);
  for (const asset of manifest.assets) {
    assert.match(asset.path, /^[A-Za-z0-9_.-]+$/, "unsafe asset basename");
    assert.ok(
      asset.path !== "." && asset.path !== ".." && !files.has(asset.path),
      "duplicate or reserved asset path",
    );
    assert.ok(
      Number.isSafeInteger(asset.bytes) && asset.bytes >= 0,
      "invalid asset size",
    );
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, "invalid asset digest");
    const bytes = await regularBytes(join(directory, asset.path));
    assert.equal(bytes.length, asset.bytes, `${asset.path} length`);
    assert.equal(hash(bytes), asset.sha256, `${asset.path} digest`);
    files.set(asset.path, bytes);
  }
  assert.deepEqual(
    (await readdir(directory)).sort(),
    [...files.keys()].sort(),
    "unlisted deployment files",
  );
  // The existing checker also proves mandatory assets, resident slots and boot
  // identity. Captured bytes are separately verified so a later source change
  // cannot silently change what is copied into the archive.
  await execute(
    process.execPath,
    [
      checker,
      directory,
      expectedRevision,
      ...(allowDevelopment ? [] : ["--release"]),
    ],
    { timeout: 30_000 },
  );
  return {
    files,
    receipt: {
      schema: SCHEMA,
      sourceRevision: expectedRevision,
      sourceDirty: manifest.distribution.triptych.dirty,
      deploymentSchema: manifest.schema,
      deploymentManifestSha256: hash(manifestBytes),
      assetCount: manifest.assets.length,
      intendedStorageSchema: storageSchema,
      runtimeQualification: "not-performed",
    },
  };
}

/** Verify current-build retained bytes, not runtime compatibility. Older
 * archives require their corresponding release verifier; this checker does not
 * infer that an old page can reopen newer saved authority. A separate same-origin
 * migrated-profile browser proof is required before calling this a rollback.
 */
export async function verifyBrowserRecoveryArchive({
  archiveDirectory,
  expectedRevision,
  allowDevelopment = false,
}) {
  const directory = resolve(archiveDirectory);
  assert.ok(
    (await lstat(directory)).isDirectory(),
    "archive must be a real directory",
  );
  const receipt = JSON.parse(
    (await regularBytes(join(directory, METADATA))).toString("utf8"),
  );
  const retained = await snapshot(
    join(directory, "site"),
    expectedRevision,
    allowDevelopment,
  );
  assert.deepEqual(
    receipt,
    retained.receipt,
    "archive metadata differs from retained deployment",
  );
  return receipt;
}

/** Create a never-overwritten directory containing exact site assets and an
 * external receipt. The receipt is written last; failures leave an incomplete
 * directory for inspection, never a falsely complete archive or altered source.
 */
export async function archiveBrowserRecovery({
  sourceDirectory,
  archiveDirectory,
  expectedRevision,
  allowDevelopment = false,
}) {
  const source = resolve(sourceDirectory);
  const requested = resolve(archiveDirectory);
  const directory = join(
    await realpath(dirname(requested)),
    basename(requested),
  );
  const sourceIdentity = await realpath(source);
  assert.ok(
    directory !== sourceIdentity &&
      !directory.startsWith(`${sourceIdentity}${sep}`),
    "archive must be outside the source deployment",
  );
  const original = await snapshot(source, expectedRevision, allowDevelopment);
  await mkdir(directory); // Exclusive reservation: any existing path is rejected.
  const site = join(directory, "site");
  await mkdir(site);
  for (const [name, bytes] of original.files) {
    await writeFile(join(site, name), bytes, { flag: "wx" });
  }
  const retained = await snapshot(site, expectedRevision, allowDevelopment);
  const current = await snapshot(source, expectedRevision, allowDevelopment);
  assert.deepEqual(
    retained.receipt,
    original.receipt,
    "retained deployment changed during copy",
  );
  assert.deepEqual(
    current.receipt,
    original.receipt,
    "source deployment changed during archive",
  );
  await writeFile(
    join(directory, METADATA),
    `${JSON.stringify(original.receipt, null, 2)}\n`,
    { flag: "wx" },
  );
  return verifyBrowserRecoveryArchive({
    archiveDirectory: directory,
    expectedRevision,
    allowDevelopment,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const [mode, ...args] = process.argv.slice(2);
    const allowDevelopment = args.at(-1) === "--allow-development";
    if (allowDevelopment) args.pop();
    let receipt;
    if (mode === "create" && args.length === 3)
      receipt = await archiveBrowserRecovery({
        sourceDirectory: args[0],
        archiveDirectory: args[1],
        expectedRevision: args[2],
        allowDevelopment,
      });
    else if (mode === "verify" && args.length === 2)
      receipt = await verifyBrowserRecoveryArchive({
        archiveDirectory: args[0],
        expectedRevision: args[1],
        allowDevelopment,
      });
    else
      throw new Error(
        "Usage: archive-browser-recovery.mjs create SOURCE NEW_ARCHIVE REVISION [--allow-development] | verify ARCHIVE REVISION [--allow-development]",
      );
    console.log(JSON.stringify({ status: "verified", ...receipt }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
