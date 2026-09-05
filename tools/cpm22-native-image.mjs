import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assembleAtomBinary as assemble } from "./lib/assemble-atom.mjs";
import { installVerifiedEditRelease } from "./lib/edit-release.mjs";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";
import { validateComponentLock } from "./lib/component-lock.mjs";
import { readVerifiedRelease } from "./lib/verified-release.mjs";
import { validateDistributionManifest } from "./lib/distribution-manifests.mjs";

const BDOS_SYSTEM_OFFSET = 0x0800;
const BIOS_SYSTEM_OFFSET = 0x1600;
const BOOT_ROM_BYTES = 0x100;
const CCP_BYTES = 0x0800;
const BDOS_BYTES = 0x0e00;
const BIOS_BYTES = 0x400;
const BACKING_SECTOR_BYTES = 512;

function padForBackingSectors(image) {
  const paddedLength =
    Math.ceil(image.length / BACKING_SECTOR_BYTES) * BACKING_SECTOR_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(image);
  return padded;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function prepareNativeCpm22Image({
  repositoryRoot,
  sourceImagePath,
  outputDirectory,
  systemCcp = "triptych",
}) {
  if (sourceImagePath === undefined) {
    if (systemCcp !== "triptych") {
      throw new Error(
        "historical CCP selection requires an explicit source image",
      );
    }
    // Interactive development may use a dirty checkout; its manifest records it.
    const distribution = await buildCpmDistribution(repositoryRoot, {
      allowDirty: true,
    });
    const bootRomPath = join(outputDirectory, "bootstrap.bin");
    const diskPath = join(outputDirectory, "cpm22.img");
    const distributionManifestPath = join(
      outputDirectory,
      "distribution.manifest.json",
    );
    await Promise.all([
      writeFile(bootRomPath, distribution.bootstrap),
      writeFile(diskPath, distribution.disk),
      writeFile(
        distributionManifestPath,
        `${JSON.stringify(distribution.manifest, null, 2)}\n`,
      ),
    ]);
    return {
      bootRomPath,
      diskPath,
      distributionManifestPath,
      workingImageSha256: distribution.manifest.disk.sha256,
    };
  }
  const [{ bootRom, ccp, bdos, bios }, sourceDisk] = await Promise.all([
    assembleTriptychCpuFirmware(repositoryRoot),
    readFile(resolve(sourceImagePath)),
  ]);

  if (sourceDisk.length < BIOS_SYSTEM_OFFSET + BIOS_BYTES) {
    throw new Error(
      `CP/M image is ${sourceDisk.length} bytes and has no complete BIOS slot`,
    );
  }

  const workingDisk = await installVerifiedEditRelease(
    sourceDisk,
    repositoryRoot,
  );
  if (systemCcp === "triptych") {
    workingDisk.set(ccp, 0);
  } else if (systemCcp !== "oracle") {
    throw new Error(`unsupported system CCP ${systemCcp}`);
  }
  workingDisk.set(bdos, BDOS_SYSTEM_OFFSET);
  workingDisk.set(bios, BIOS_SYSTEM_OFFSET);
  const paddedDisk = padForBackingSectors(workingDisk);
  const bootRomPath = join(outputDirectory, "bootstrap.bin");
  const diskPath = join(outputDirectory, "cpm22.img");
  await Promise.all([
    writeFile(bootRomPath, bootRom),
    writeFile(diskPath, paddedDisk),
  ]);

  return {
    bootRomPath,
    diskPath,
    sourceImageSha256: sha256(sourceDisk),
    workingImageSha256: sha256(paddedDisk),
  };
}

/**
 * Installs the pinned portable CCP/BDOS and local Triptych BIOS in an existing working
 * disk.
 * The disk is published by one same-directory rename, so an assembly or write
 * failure cannot leave a partly patched image behind.
 */
export async function prepareNativeCpm22WorkingImage({
  repositoryRoot,
  workingImagePath,
  outputDirectory,
  systemCcp = "triptych",
}) {
  const resolvedDiskPath = resolve(workingImagePath);
  const [{ bootRom, ccp, bdos, bios }, sourceDisk] = await Promise.all([
    assembleTriptychCpuFirmware(repositoryRoot),
    readFile(resolvedDiskPath),
  ]);

  if (sourceDisk.length < BIOS_SYSTEM_OFFSET + BIOS_BYTES) {
    throw new Error(
      `CP/M image is ${sourceDisk.length} bytes and has no complete BIOS slot`,
    );
  }
  if (sourceDisk.length % BACKING_SECTOR_BYTES !== 0) {
    throw new Error(
      `persistent CP/M working image must contain complete ${BACKING_SECTOR_BYTES}-byte backing sectors`,
    );
  }

  const workingDisk = Uint8Array.from(sourceDisk);
  if (systemCcp === "triptych") {
    workingDisk.set(ccp, 0);
  } else if (systemCcp !== "oracle") {
    throw new Error(`unsupported system CCP ${systemCcp}`);
  }
  workingDisk.set(bdos, BDOS_SYSTEM_OFFSET);
  workingDisk.set(bios, BIOS_SYSTEM_OFFSET);
  const temporaryDiskPath = `${resolvedDiskPath}.triptych-system-${process.pid}.tmp`;
  try {
    await writeFile(temporaryDiskPath, workingDisk, { flag: "wx" });
    await rename(temporaryDiskPath, resolvedDiskPath);
  } catch (error) {
    await rm(temporaryDiskPath, { force: true });
    throw error;
  }

  const bootRomPath = join(outputDirectory, "bootstrap.bin");
  await writeFile(bootRomPath, bootRom);
  return {
    bootRomPath,
    diskPath: resolvedDiskPath,
    sourceImageSha256: sha256(sourceDisk),
    workingImageSha256: sha256(workingDisk),
  };
}

export async function assembleTriptychCpuFirmware(repositoryRoot) {
  const sourceDirectory = join(repositoryRoot, "roms", "cpu");
  const lock = validateComponentLock(
    JSON.parse(
      await readFile(
        join(repositoryRoot, "distribution/components.lock.json"),
        "utf8",
      ),
    ),
    { recipes: new Set(["verified-release", "atom-binary", "atom-cpm22"]) },
  );
  assert.equal(lock.targetProfile, "triptych-cpu-v0.1");
  async function resident(id) {
    const component = lock.components.find((entry) => entry.id === id);
    assert.ok(component, `distribution lock is missing ${id}`);
    const verified = await readVerifiedRelease(repositoryRoot, component);
    validateDistributionManifest(
      component,
      verified.manifest,
      lock.atom.revision,
    );
    return verified.bytes;
  }
  const [bootRom, ccp, bdos, bios] = await Promise.all([
    assemble(join(sourceDirectory, "bootstrap.asm")),
    resident("ccp"),
    resident("bdos"),
    assemble(join(repositoryRoot, "system", "cpm", "bios.asm")),
  ]);
  if (bootRom.length !== BOOT_ROM_BYTES) {
    throw new Error(
      `bootstrap is ${bootRom.length} bytes; expected ${BOOT_ROM_BYTES}`,
    );
  }
  if (bios.length !== BIOS_BYTES) {
    throw new Error(`BIOS is ${bios.length} bytes; expected ${BIOS_BYTES}`);
  }
  if (ccp.length !== CCP_BYTES) {
    throw new Error(`CCP is ${ccp.length} bytes; expected ${CCP_BYTES}`);
  }
  if (bdos.length !== BDOS_BYTES) {
    throw new Error(`BDOS is ${bdos.length} bytes; expected ${BDOS_BYTES}`);
  }
  return { bootRom, ccp, bdos, bios };
}
