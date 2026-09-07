import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { test } from "node:test";
import { buildCpmDistribution } from "./cpm-distribution.mjs";
import { buildLargeDiskSystem } from "./large-disk-system.mjs";
import { buildLargeAbSystem } from "./large-ab-system.mjs";

const root = resolve(import.meta.dirname, "../..");
const distribution = await buildCpmDistribution(root, { allowDirty: true });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("retained A/B release reproduces separate system and bootstrap assets without changing default media", async () => {
  const before = hash(distribution.disk);
  const [ab, single] = await Promise.all([
    buildLargeAbSystem(root, distribution),
    buildLargeDiskSystem(root, distribution),
  ]);
  assert.equal(ab.profile.residentProfile, "triptych-cpu-v0.1-8m-ab");
  assert.equal(ab.profile.drives, 2);
  assert.equal(
    ab.components.find((c) => c.name === "CAVERNS.COM").bytes,
    distribution.manifest.components.find((c) => c.id === "caverns80").bytes,
  );
  assert.equal(
    ab.components.find((c) => c.name === "HYPERDRV.COM").bytes,
    distribution.manifest.components.find((c) => c.id === "hyperdrive").bytes,
  );
  assert.equal(ab.bytes.length, 16384);
  assert.equal(ab.bootstrap.length, 256);
  assert.notEqual(ab.profile.systemAsset, single.profile.systemAsset);
  assert.notEqual(hash(ab.bootstrap), hash(distribution.bootstrap));
  assert.equal(
    ab.profile.ccpSha256,
    "767891db9e1322b5dd5c3e73a2ab87c85756456f74517762ff018e0b6dbd2a63",
  );
  assert.equal(
    ab.profile.bdosSha256,
    "817b0e03552db6a2b369471402524e6c1bebf54163f0d95b75b911c06642fce5",
  );
  assert.equal(ab.profile.bios.liveEnd, 0xfbe1);
  assert.equal(
    ab.profile.bios.sha256,
    "316f56f30c19416f6229fd760bacc8cad3baab65c6b15f8e856b175ce4c44907",
  );
  assert.ok(ab.bytes.subarray(0xfc00 - 0xe300).every((byte) => byte === 0));
  assert.equal(ab.resident.bdosStackTop - ab.resident.bdosStackBase, 64);
  assert.ok(ab.resident.ccpStackGuardStart >= ab.resident.ccpWritableStart);
  assert.ok(ab.resident.ccpStackGuardEnd <= 0xeb00);
  assert.deepEqual(
    ab.resident.biosImmutableRanges.map(({ start, end }) => [start, end]),
    [
      [0xf900, 0xfb09],
      [0xfb32, 0xfb41],
    ],
  );
  assert.equal(hash(distribution.disk), before);
});

test("A/B construction rejects mismatched distribution or assembler identity", async () => {
  const disk = distribution.disk.slice();
  disk[0] ^= 1;
  await assert.rejects(
    buildLargeAbSystem(root, { ...distribution, disk }),
    /digest/,
  );
  for (const mutate of [
    (m) => {
      m.targetProfile = "triptych-cpu-v0.1-8m-ab";
    },
    (m) => {
      m.atom.revision = "a".repeat(40);
    },
    (m) => {
      m.bootstrap.sha256 = "0".repeat(64);
    },
    (m) => {
      m.components.find((c) => c.id === "atom").bytes = 0xe201;
    },
  ]) {
    const manifest = structuredClone(distribution.manifest);
    mutate(manifest);
    await assert.rejects(
      buildLargeAbSystem(root, { ...distribution, manifest }),
    );
  }
});
