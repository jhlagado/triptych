// Explicit release operation; never builds, commits, pushes or deletes history.
// node tools/pin-disk-library.mjs BUILD_DIR EXPECTED_REVISION [--advance-defaults] [--history DIR]
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readDiskLibraryPackage } from "./lib/disk-library-package.mjs";
import { pinQualifiedDiskLibraryPackage } from "./lib/disk-library-pin.mjs";

const usage =
  "Usage: node tools/pin-disk-library.mjs BUILD_DIR EXPECTED_40_HEX_REVISION [--advance-defaults] [--history DIR]";
const args = process.argv.slice(2);
if (args.length < 2 || !/^[a-f0-9]{40}$/.test(args[1])) throw new Error(usage);
const directory = resolve(args[0]);
const revision = args[1];
const root = resolve(import.meta.dirname, "..");
let historyDirectory = join(root, "distribution", "disk-library"),
  advanceDefaults = false;
const seen = new Set();
for (let i = 2; i < args.length; i++) {
  const flag = args[i];
  if (seen.has(flag)) throw new Error(usage);
  seen.add(flag);
  if (flag === "--advance-defaults") advanceDefaults = true;
  else if (flag === "--history" && args[i + 1] && !args[i + 1].startsWith("--"))
    historyDirectory = resolve(args[++i]);
  else throw new Error(usage);
}
assert.notEqual(
  directory,
  historyDirectory,
  "build and retained history must be separate directories",
);
async function metadata(name) {
  const handle = await open(
    join(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    assert(
      stat.isFile() && stat.size <= 16 * 1024 * 1024,
      "bounded regular metadata",
    );
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    assert.equal(used, stat.size, "metadata changed while reading");
    return bytes.subarray(0, used);
  } finally {
    await handle.close();
  }
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const deploymentBytes = await metadata("deployment-manifest.json");
const deployment = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(deploymentBytes),
);
assert.equal(deployment.schema, "triptych-browser-deployment-v1");
assert.equal(deployment.storageSchema, "triptych-disk-box-v1");
assert.equal(
  deployment.distribution.triptych.revision,
  revision,
  "release source revision differs",
);
assert.equal(
  deployment.distribution.triptych.dirty,
  false,
  "refusing to pin a dirty development build",
);
assert(Array.isArray(deployment.assets) && deployment.assets.length <= 4096);
let total = 0;
const listed = new Map();
for (const row of deployment.assets) {
  assert(
    typeof row.path === "string" &&
      /^[A-Za-z0-9_.-]{1,200}$/.test(row.path) &&
      ![".", ".."].includes(row.path),
  );
  assert(!listed.has(row.path));
  assert(
    Number.isSafeInteger(row.bytes) &&
      row.bytes >= 0 &&
      row.bytes <= 16 * 1024 * 1024,
  );
  total += row.bytes;
  assert(total <= 1024 * 1024 * 1024, "deployment aggregate bound");
  listed.set(row.path, row);
}
const registryBytes = await metadata("disk-library-registry.json");
const candidate = await readDiskLibraryPackage(directory);
for (const row of [
  ...candidate.manifest.assets,
  {
    path: "disk-library-registry.json",
    bytes: registryBytes.length,
    sha256: hash(registryBytes),
  },
]) {
  assert.deepEqual(
    listed.get(row.path),
    row,
    "retained package differs from deployment asset evidence",
  );
}
const { stdout } = await promisify(execFile)(
  process.execPath,
  [
    join(root, "tools/check-browser-deployment.mjs"),
    directory,
    revision,
    "--release",
    "--require-two-mib",
  ],
  { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 },
);
// The captured package is already owned. Bind it to the unchanged envelope and
// exact registry which the full existing release checker just qualified.
assert.deepEqual(
  await metadata("deployment-manifest.json"),
  deploymentBytes,
  "deployment changed during release check",
);
assert.deepEqual(
  await metadata("disk-library-registry.json"),
  registryBytes,
  "registry changed during release check",
);
assert.deepEqual(
  candidate.manifest,
  (await readDiskLibraryPackage(directory)).manifest,
  "package changed during release check",
);
const result = await pinQualifiedDiskLibraryPackage(
  historyDirectory,
  candidate,
  {
    advanceDefaults,
  },
);
console.log(
  JSON.stringify(
    {
      status: "pinned",
      revision,
      historyDirectory,
      assets: result.assets,
      defaultsAdvanced: result.defaultsAdvanced,
      checker: JSON.parse(stdout.trim()),
    },
    null,
    2,
  ),
);
