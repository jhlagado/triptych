import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { compile, defaultFormatWriters } from "@jhlagado/azm/compile";

const BIOS_SYSTEM_OFFSET = 0x1600;
const BOOT_ROM_BYTES = 0x100;
const BIOS_BYTES = 0x400;
const BACKING_SECTOR_BYTES = 512;

async function assemble(source) {
  const result = await compile(
    source,
    {
      emitBin: true,
      emitHex: false,
      emitD8m: false,
      emitLst: false,
      emitAsm80: false,
      registerContracts: "off",
      registerContractsInterfaces: [],
    },
    { formats: defaultFormatWriters },
  );
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  if (errors.length > 0) {
    throw new Error(
      errors
        .map(
          (diagnostic) =>
            `${diagnostic.sourceName}:${diagnostic.line}:${diagnostic.column}: ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }
  const binary = result.artifacts.find((artifact) => artifact.kind === "bin");
  if (binary?.kind !== "bin") {
    throw new Error(`AZM did not emit a binary for ${source}`);
  }
  return binary.bytes;
}

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
}) {
  const [{ bootRom, bios }, sourceDisk] = await Promise.all([
    assembleTriptychCpuFirmware(repositoryRoot),
    readFile(resolve(sourceImagePath)),
  ]);

  if (sourceDisk.length < BIOS_SYSTEM_OFFSET + BIOS_BYTES) {
    throw new Error(
      `CP/M image is ${sourceDisk.length} bytes and has no complete BIOS slot`,
    );
  }

  const workingDisk = Uint8Array.from(sourceDisk);
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
 * Installs the current Triptych BIOS in an existing persistent working disk.
 * The disk is published by one same-directory rename, so an assembly or write
 * failure cannot leave a partly patched image behind.
 */
export async function prepareNativeCpm22WorkingImage({
  repositoryRoot,
  workingImagePath,
  outputDirectory,
}) {
  const resolvedDiskPath = resolve(workingImagePath);
  const [{ bootRom, bios }, sourceDisk] = await Promise.all([
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
  workingDisk.set(bios, BIOS_SYSTEM_OFFSET);
  const temporaryDiskPath = `${resolvedDiskPath}.triptych-bios-${process.pid}.tmp`;
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
  const [bootRom, bios] = await Promise.all([
    assemble(join(sourceDirectory, "bootstrap.asm")),
    assemble(join(sourceDirectory, "bios.asm")),
  ]);
  if (bootRom.length !== BOOT_ROM_BYTES) {
    throw new Error(
      `bootstrap is ${bootRom.length} bytes; expected ${BOOT_ROM_BYTES}`,
    );
  }
  if (bios.length !== BIOS_BYTES) {
    throw new Error(`BIOS is ${bios.length} bytes; expected ${BIOS_BYTES}`);
  }
  return { bootRom, bios };
}
