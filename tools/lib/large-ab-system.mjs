import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { assembleAtomFile } from "./assemble-atom.mjs";
import { assemblePortableCpmSource } from "./portable-cpm-source.mjs";
import { validateComponentLock } from "./component-lock.mjs";

export const LARGE_AB_PROFILE = "triptych-cpu-v0.1-8m-ab";
export const LARGE_AB_SYSTEM_ASSET = "system-triptych-cpm-8m-ab-v1.bin";
export const LARGE_AB_BOOTSTRAP_ASSET = "bootstrap-triptych-cpm-8m-ab-v1.bin";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build distinct A/B artifacts from retained releases and ATOM source.
 * The verified default distribution supplies applications and ATOM identity.
 * No source checkout lookup, relocation, saved-media read or publication.
 */
export async function buildLargeAbSystem(repositoryRoot, distribution) {
  const { manifest, disk, bootstrap } = distribution;
  assert.equal(manifest.targetProfile, "triptych-cpu-v0.1");
  assert.equal(disk.length, manifest.disk.bytes);
  assert.equal(hash(disk), manifest.disk.sha256, "default distribution digest");
  assert.equal(bootstrap.length, manifest.bootstrap.bytes);
  assert.equal(hash(bootstrap), manifest.bootstrap.sha256);
  const lockBytes = await readFile(
    join(repositoryRoot, "distribution/residents-8m-ab.lock.json"),
  );
  const lock = validateComponentLock(JSON.parse(lockBytes), {
    recipes: new Set(["verified-release"]),
  });
  assert.equal(lock.targetProfile, LARGE_AB_PROFILE);
  assert.deepEqual(lock.disk, {
    bytes: 8388608,
    recordBytes: 128,
    systemRecords: 128,
  });
  assert.deepEqual(lock.atom, manifest.atom, "one qualified ATOM identity");
  assert.deepEqual(
    lock.components.map(({ id }) => id),
    ["ccp", "bdos"],
  );
  assert.equal(
    lock.components[0].source.revision,
    lock.components[1].source.revision,
    "one OS release revision",
  );
  assert.equal(
    lock.components[0].artifact.manifest,
    lock.components[1].artifact.manifest,
    "one OS profile manifest",
  );
  const [ccp, bdos, bios, boot] = await Promise.all([
    assemblePortableCpmSource(repositoryRoot, "ccp", LARGE_AB_PROFILE),
    assemblePortableCpmSource(repositoryRoot, "bdos", LARGE_AB_PROFILE),
    assembleAtomFile(join(repositoryRoot, "system/cpm/bios-8m-ab.asm")),
    assembleAtomFile(join(repositoryRoot, "roms/cpu/bootstrap-8m-ab.asm")),
  ]);
  assert.equal(ccp.base, 0xe300);
  assert.equal(bdos.base, 0xeb00);
  assert.equal(bios.base, 0xf900);
  assert.equal(bios.bytes.length, 1024);
  assert.equal(boot.base, 0);
  assert.equal(boot.bytes.length, 256);
  const liveEnd = bios.labels.BOOTSP;
  assert.ok(liveEnd > bios.base && liveEnd <= 0xfc00, "live BIOS below ALV A");
  assert.ok(
    bios.bytes.subarray(liveEnd - bios.base).every((byte) => byte === 0),
    "dead BIOS padding is zero",
  );
  const bytes = new Uint8Array(16384);
  bytes.set(ccp.bytes);
  bytes.set(bdos.bytes, 2048);
  bytes.set(bios.bytes, 5632);
  const components = manifest.components
    .filter(({ id }) => ["atom", "nucleus", "edit"].includes(id))
    .map((component) => {
      assert.ok(
        component.bytes > 0 && component.bytes <= 0xe200,
        "binary fits A/B load area; runtime qualified separately",
      );
      return {
        name: component.install.name,
        bytes: component.bytes,
        sha256: component.sha256,
      };
    });
  assert.deepEqual(
    components.map(({ name }) => name),
    ["ATOM.COM", "NUC.COM", "EDIT.COM"],
  );
  const immutable = (start, end) => {
    assert.ok(start >= bios.base && end > start && end <= liveEnd);
    return {
      start,
      end,
      bytes: bios.bytes.slice(start - bios.base, end - bios.base),
    };
  };
  return {
    bytes,
    bootstrap: boot.bytes,
    components,
    resident: {
      ccpBytes: ccp.bytes,
      ccpWritableStart: ccp.labels.CMDFCB,
      ccpStackGuardStart: ccp.labels.STKGUARD,
      ccpStackGuardEnd: ccp.labels.STKGUEND,
      bdosBytes: bdos.bytes,
      bdosWritableStart: bdos.labels.OLDSP,
      bdosStackBase: bdos.labels.STKBASE,
      bdosStackTop: bdos.labels.STKTOP,
      biosImmutableRanges: [
        immutable(bios.base, bios.labels.BOOTREC),
        immutable(bios.labels.DPBLOCK, bios.labels.DIRBUF),
      ],
    },
    profile: {
      id: "triptych-cpm-8m-v1",
      residentProfile: LARGE_AB_PROFILE,
      imageBytes: 8388608,
      systemBytes: bytes.length,
      drives: 2,
      systemAsset: LARGE_AB_SYSTEM_ASSET,
      systemSha256: hash(bytes),
      bootstrapAsset: LARGE_AB_BOOTSTRAP_ASSET,
      bootstrapSha256: hash(boot.bytes),
      residentLockSha256: hash(lockBytes),
      ccpSha256: hash(ccp.bytes),
      bdosSha256: hash(bdos.bytes),
      bios: {
        source: "system/cpm/bios-8m-ab.asm",
        sourceSha256: hash(
          await readFile(join(repositoryRoot, "system/cpm/bios-8m-ab.asm")),
        ),
        sha256: hash(bios.bytes),
        liveEnd,
      },
    },
  };
}
