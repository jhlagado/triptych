import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
      writeFile(bootRomPath, distribution.bootstrap, { flag: "wx" }),
      writeFile(diskPath, distribution.disk, { flag: "wx" }),
      writeFile(
        distributionManifestPath,
        `${JSON.stringify(distribution.manifest, null, 2)}\n`,
        { flag: "wx" },
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
    writeFile(bootRomPath, bootRom, { flag: "wx" }),
    writeFile(diskPath, paddedDisk, { flag: "wx" }),
  ]);

  return {
    bootRomPath,
    diskPath,
    sourceImageSha256: sha256(sourceDisk),
    workingImageSha256: sha256(paddedDisk),
  };
}

/**
 * Reopens the exact saved bytes. Bootstrap selection is a caller assertion about
 * resident layout, not an identification or validation of the saved operating
 * system. This path never installs resident releases or adapts the working disk.
 */
export async function prepareNativeCpm22WorkingImage({
  repositoryRoot,
  workingImagePath,
  outputDirectory,
  bootstrapProfile = "triptych-cpu-v0.1",
  systemCcp,
}) {
  if (systemCcp !== undefined) {
    throw new Error(
      "persistent reopening preserves the saved CCP; CCP selection requires an explicit disposable source copy",
    );
  }
  const profiles = {
    "triptych-cpu-v0.1": { source: "bootstrap.asm", imageBytes: 256512 },
    "triptych-cpu-v0.1-8m-a": { source: "bootstrap.asm", imageBytes: 8388608 },
    "triptych-cpu-v0.1-8m-ab": {
      source: "bootstrap-8m-ab.asm",
      imageBytes: 8388608,
    },
  };
  if (!Object.hasOwn(profiles, bootstrapProfile)) {
    throw new Error(
      `unsupported persistent bootstrap profile ${bootstrapProfile}`,
    );
  }
  const profile = profiles[bootstrapProfile];
  const resolvedDiskPath = resolve(workingImagePath);
  const sourceDisk = await readFile(resolvedDiskPath);
  if (sourceDisk.length % BACKING_SECTOR_BYTES !== 0) {
    throw new Error(
      `persistent CP/M working image must contain complete ${BACKING_SECTOR_BYTES}-byte backing sectors`,
    );
  }

  if (sourceDisk.length !== profile.imageBytes) {
    throw new Error(
      `persistent image length ${sourceDisk.length} does not match selected bootstrap profile ${bootstrapProfile}; select the known saved resident profile explicitly`,
    );
  }
  const bootRom = await assemble(
    join(repositoryRoot, "roms/cpu", profile.source),
  );
  assert.equal(
    bootRom.length,
    BOOT_ROM_BYTES,
    "persistent bootstrap byte count",
  );
  const bootRomPath = join(outputDirectory, "bootstrap.bin");
  assert.notEqual(
    resolve(bootRomPath),
    resolvedDiskPath,
    "bootstrap output must not replace the working disk",
  );
  // Exclusive creation prevents an existing link from aliasing the saved disk.
  await writeFile(bootRomPath, bootRom, { flag: "wx" });
  return {
    bootRomPath,
    diskPath: resolvedDiskPath,
    sourceImageSha256: sha256(sourceDisk),
    workingImageSha256: sha256(sourceDisk),
    bootstrapProfile,
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
