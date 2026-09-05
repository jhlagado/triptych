import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildCpmDistribution } from "../../tools/lib/cpm-distribution.mjs";
import {
  installCpm22File,
  readCpm22File,
} from "../../tools/lib/cpm22-disk.mjs";
import {
  assembleTriptychCpuFirmware,
  prepareNativeCpm22Image,
  prepareNativeCpm22WorkingImage,
} from "../../tools/cpm22-native-image.mjs";

const root = resolve(import.meta.dirname, "../..");
const temporary = [];
let canonical;
beforeAll(async () => {
  canonical = await buildCpmDistribution(root, { allowDirty: true });
});
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "triptych-native-distribution-"));
  temporary.push(path);
  return path;
}

describe("native distribution inputs", () => {
  it("defaults to canonical fresh distribution bytes and records development provenance", async () => {
    const prepared = await prepareNativeCpm22Image({
      repositoryRoot: root,
      outputDirectory: await directory(),
    });
    expect(new Uint8Array(await readFile(prepared.diskPath))).toEqual(
      canonical.disk,
    );
    expect(new Uint8Array(await readFile(prepared.bootRomPath))).toEqual(
      canonical.bootstrap,
    );
    const manifest = JSON.parse(
      await readFile(prepared.distributionManifestPath, "utf8"),
    );
    expect(manifest).toEqual(canonical.manifest);
    expect(prepared.workingImageSha256).toBe(manifest.disk.sha256);
  });

  it("loads released residents without transitional CCP/BDOS source copies", async () => {
    const fixture = await directory();
    for (const relative of [
      "distribution",
      "third_party/portable-cpm",
      "roms/cpu",
      "system/cpm",
    ]) {
      await mkdir(join(fixture, relative), { recursive: true });
    }
    for (const relative of [
      "distribution/components.lock.json",
      "roms/cpu/bootstrap.asm",
      "system/cpm/bios.asm",
    ]) {
      await cp(join(root, relative), join(fixture, relative));
    }
    await cp(
      join(root, "third_party/portable-cpm"),
      join(fixture, "third_party/portable-cpm"),
      { recursive: true },
    );
    const firmware = await assembleTriptychCpuFirmware(fixture);
    expect(firmware.ccp).toEqual(canonical.disk.slice(0, 0x800));
    expect(firmware.bdos).toEqual(canonical.disk.slice(0x800, 0x1600));
    expect(firmware.bios).toEqual(canonical.disk.slice(0x1600, 0x1a00));
    expect(firmware.bootRom).toEqual(canonical.bootstrap);
    await writeFile(
      join(fixture, "third_party/portable-cpm/manifest.json"),
      "{}\n",
    );
    await expect(assembleTriptychCpuFirmware(fixture)).rejects.toThrow(
      "release manifest SHA-256",
    );
  });

  it("retains explicit source selection and historical CCP without mutating the source", async () => {
    const outputDirectory = await directory();
    const source = installCpm22File(canonical.disk, {
      name: "NUC.COM",
      bytes: Buffer.from("explicit source application"),
    });
    source.fill(0x66, 0, 0x800);
    const sourceImagePath = join(outputDirectory, "source.img");
    await writeFile(sourceImagePath, source);
    const prepared = await prepareNativeCpm22Image({
      repositoryRoot: root,
      sourceImagePath,
      outputDirectory,
      systemCcp: "oracle",
    });
    const disk = new Uint8Array(await readFile(prepared.diskPath));
    expect(new Uint8Array(await readFile(sourceImagePath))).toEqual(source);
    expect(disk.slice(0, 0x800)).toEqual(source.slice(0, 0x800));
    expect(disk.slice(0x800, 0x1a00)).toEqual(
      canonical.disk.slice(0x800, 0x1a00),
    );
    expect(readCpm22File(disk, "NUC.COM")).toEqual(
      readCpm22File(source, "NUC.COM"),
    );
    expect(prepared.distributionManifestPath).toBeUndefined();
  });

  it("refreshes working resident slots without replacing applications or user records", async () => {
    const outputDirectory = await directory();
    let disk = canonical.disk;
    for (const name of ["EDIT.COM", "NUC.COM", "ATOM.COM", "WORK.TXT"]) {
      disk = installCpm22File(disk, {
        name,
        bytes: Buffer.from(`user-owned ${name}`),
      });
    }
    disk.fill(0x55, 0, 0x1a00);
    const workingImagePath = join(outputDirectory, "working.img");
    await writeFile(workingImagePath, disk);
    const prepared = await prepareNativeCpm22WorkingImage({
      repositoryRoot: root,
      workingImagePath,
      outputDirectory,
    });
    const saved = new Uint8Array(await readFile(workingImagePath));
    expect(prepared.diskPath).toBe(workingImagePath);
    expect(saved.slice(0, 0x1a00)).toEqual(canonical.disk.slice(0, 0x1a00));
    expect(saved.slice(0x1a00)).toEqual(disk.slice(0x1a00));
    for (const name of ["EDIT.COM", "NUC.COM", "ATOM.COM", "WORK.TXT"]) {
      expect(readCpm22File(saved, name)).toEqual(readCpm22File(disk, name));
    }
  });

  it("requires an explicit source for historical CCP selection", async () => {
    await expect(
      prepareNativeCpm22Image({
        repositoryRoot: root,
        outputDirectory: await directory(),
        systemCcp: "oracle",
      }),
    ).rejects.toThrow(/explicit source/i);
  });
});
