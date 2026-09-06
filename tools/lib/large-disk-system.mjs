import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { assembleAtomFile } from "./assemble-atom.mjs";

export const LARGE_DISK_SYSTEM_ASSET = "system-triptych-cpm-8m-v1.bin";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build the one-drive system area from a verified default distribution.
 * This preserves the released CCP/BDOS and their application memory profile.
 * It produces system records, never reformats or modifies an existing disk.
 */
export async function buildLargeDiskSystem(repositoryRoot, distribution) {
  const { manifest, disk } = distribution;
  assert.equal(manifest.targetProfile, "triptych-cpu-v0.1");
  assert.ok(disk instanceof Uint8Array);
  assert.equal(disk.length, manifest.disk.bytes, "distribution disk length");
  assert.equal(hash(disk), manifest.disk.sha256, "distribution disk digest");
  assert.equal(distribution.bootstrap.length, manifest.bootstrap.bytes);
  assert.equal(
    hash(distribution.bootstrap),
    manifest.bootstrap.sha256,
    "distribution bootstrap digest",
  );
  for (const [id, origin, firstRecord, recordCount] of [
    ["ccp", 0xe400, 0, 16],
    ["bdos", 0xec00, 16, 28],
  ]) {
    const matches = manifest.components.filter((item) => item.id === id);
    assert.equal(matches.length, 1, `one ${id} component is required`);
    const component = matches[0];
    assert.deepEqual(component.target, {
      origin,
      capacity: recordCount * 128,
    });
    assert.deepEqual(component.install, {
      kind: "system-records",
      firstRecord,
      recordCount,
    });
    assert.equal(component.bytes, recordCount * 128);
    assert.equal(
      hash(disk.subarray(firstRecord * 128, (firstRecord + recordCount) * 128)),
      component.sha256,
      `${id} system-record digest`,
    );
  }
  const bios = await assembleAtomFile(
    join(repositoryRoot, "system/cpm/bios-8m.asm"),
  );
  assert.equal(bios.base, 0xfa00, "large-disk BIOS origin");
  assert.equal(bios.bytes.length, 1024, "large-disk BIOS slot");
  const bytes = new Uint8Array(16384);
  bytes.set(disk.subarray(0, 0x1600));
  bytes.set(bios.bytes, 0x1600);
  return {
    bytes,
    profile: {
      id: "triptych-cpm-8m-v1",
      residentProfile: "triptych-cpu-v0.1-8m-a",
      imageBytes: 8388608,
      systemBytes: bytes.length,
      drives: 1,
      systemAsset: LARGE_DISK_SYSTEM_ASSET,
      bootstrapSha256: hash(distribution.bootstrap),
      ccpSha256: hash(bytes.subarray(0, 0x800)),
      bdosSha256: hash(bytes.subarray(0x800, 0x1600)),
      bios: {
        source: "system/cpm/bios-8m.asm",
        sourceSha256: hash(
          await readFile(join(repositoryRoot, "system/cpm/bios-8m.asm")),
        ),
        sha256: hash(bios.bytes),
      },
    },
  };
}
