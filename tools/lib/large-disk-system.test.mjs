import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildCpmDistribution } from "./cpm-distribution.mjs";
import { buildLargeDiskSystem } from "./large-disk-system.mjs";

const root = resolve(import.meta.dirname, "../..");
const distribution = await buildCpmDistribution(root, { allowDirty: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("large system area preserves pinned residents and has the qualified BIOS and zero reserved tail", async () => {
  const before = hash(distribution.disk);
  const { bytes, profile } = await buildLargeDiskSystem(root, distribution);
  assert.equal(profile.id, "triptych-cpm-8m-v1");
  assert.equal(profile.residentProfile, "triptych-cpu-v0.1-8m-a");
  assert.equal(profile.drives, 1);
  assert.equal(profile.bootstrapSha256, hash(distribution.bootstrap));
  assert.equal(profile.bdosSha256, hash(bytes.subarray(0x800, 0x1600)));
  assert.equal(bytes.length, 16384);
  assert.deepEqual(
    bytes.subarray(0, 0x1600),
    distribution.disk.subarray(0, 0x1600),
  );
  assert.equal(
    hash(bytes.subarray(0x1600, 0x1a00)),
    "ef7558fcf3a9b99c814b50f196c0e053b3c4bb6e8c1114e0b91fd2e6e017764c",
  );
  assert.ok(bytes.subarray(0x1a00).every((byte) => byte === 0));
  assert.equal(hash(distribution.disk), before);
});

test("mixed disk bytes or incompatible resident metadata cannot produce a system asset", async () => {
  const alteredDisk = distribution.disk.slice();
  alteredDisk[0] ^= 1;
  await assert.rejects(
    buildLargeDiskSystem(root, { ...distribution, disk: alteredDisk }),
    /distribution disk digest/,
  );
  for (const mutate of [
    (manifest) => {
      manifest.targetProfile = "other-profile";
    },
    (manifest) => {
      manifest.bootstrap.sha256 = "0".repeat(64);
    },
    (manifest) => {
      manifest.components.find((c) => c.id === "bdos").sha256 = "0".repeat(64);
    },
    (manifest) => {
      manifest.components.find((c) => c.id === "ccp").target.origin = 0xe200;
    },
    (manifest) => {
      manifest.components.push(
        manifest.components.find((c) => c.id === "bdos"),
      );
    },
  ]) {
    const manifest = structuredClone(distribution.manifest);
    mutate(manifest);
    await assert.rejects(
      buildLargeDiskSystem(root, { ...distribution, manifest }),
    );
  }
});
