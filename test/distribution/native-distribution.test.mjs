import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildCpmDistribution } from "../../tools/lib/cpm-distribution.mjs";
import { assembleAtomBinary } from "../../tools/lib/assemble-atom.mjs";
import { createCpmWorkingImage } from "../../tools/create-cpm-working-image.mjs";
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
  it("creates a fresh pinned working image through the public CLI without clobbering saved media", async () => {
    const outputDirectory = await directory();
    const destination = join(outputDirectory, "new.img");
    const cli = spawnSync(
      process.execPath,
      [
        join(root, "tools/create-cpm-working-image.mjs"),
        destination,
        "--allow-dirty",
      ],
      { encoding: "utf8", timeout: 30000 },
    );
    expect(cli.status, cli.stderr).toBe(0);
    const report = JSON.parse(cli.stdout);
    expect(report.diskPath).toBe(destination);
    expect(report.manifest).toEqual(canonical.manifest);
    expect(new Uint8Array(await readFile(destination))).toEqual(canonical.disk);
    const saved = Buffer.from("preexisting saved bytes");
    await writeFile(destination, saved);
    await expect(
      createCpmWorkingImage(destination, { allowDirty: true }),
    ).rejects.toThrow(/EEXIST/);
    expect(await readFile(destination)).toEqual(saved);
    expect(await readdir(outputDirectory)).toEqual(["new.img"]);
  });

  it("refuses an existing destination link and cleans private creation files", async () => {
    const outputDirectory = await directory();
    const source = join(outputDirectory, "saved.img");
    const destination = join(outputDirectory, "new.img");
    await writeFile(source, "saved");
    await symlink(source, destination);
    await expect(
      createCpmWorkingImage(destination, { allowDirty: true }),
    ).rejects.toThrow(/EEXIST/);
    expect(await readFile(source, "utf8")).toBe("saved");
    expect((await readdir(outputDirectory)).sort()).toEqual([
      "new.img",
      "saved.img",
    ]);
  });

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

  it.each(["cpm22.img", "bootstrap.bin"])(
    "refuses disposable output %s when it is the source itself",
    async (name) => {
      const outputDirectory = await directory();
      const sourceImagePath = join(outputDirectory, name);
      const source = canonical.disk.slice();
      source.fill(0x63, 0, 0x1a00);
      await writeFile(sourceImagePath, source);
      await expect(
        prepareNativeCpm22Image({
          repositoryRoot: root,
          sourceImagePath,
          outputDirectory,
        }),
      ).rejects.toThrow(/EEXIST/);
      expect(new Uint8Array(await readFile(sourceImagePath))).toEqual(source);
    },
  );

  it.each([
    ["cpm22.img", "symlink"],
    ["cpm22.img", "hardlink"],
    ["bootstrap.bin", "symlink"],
    ["bootstrap.bin", "hardlink"],
  ])(
    "refuses disposable output %s when it is a %s to the source",
    async (name, kind) => {
      const outputDirectory = await directory();
      const sourceImagePath = join(outputDirectory, "source.img");
      const source = canonical.disk.slice();
      source.fill(0x63, 0, 0x1a00);
      await writeFile(sourceImagePath, source);
      await (kind === "symlink" ? symlink : link)(
        sourceImagePath,
        join(outputDirectory, name),
      );
      await expect(
        prepareNativeCpm22Image({
          repositoryRoot: root,
          sourceImagePath,
          outputDirectory,
        }),
      ).rejects.toThrow(/EEXIST/);
      expect(new Uint8Array(await readFile(sourceImagePath))).toEqual(source);
    },
  );

  it.each(["cpm22.img", "bootstrap.bin", "distribution.manifest.json"])(
    "refuses fresh disposable output %s when it aliases saved bytes",
    async (name) => {
      const outputDirectory = await directory();
      const savedPath = join(outputDirectory, "saved.img");
      const saved = Buffer.from("unrelated saved bytes");
      await writeFile(savedPath, saved);
      await link(savedPath, join(outputDirectory, name));
      await expect(
        prepareNativeCpm22Image({
          repositoryRoot: root,
          outputDirectory,
        }),
      ).rejects.toThrow(/EEXIST/);
      expect(await readFile(savedPath)).toEqual(saved);
    },
  );

  it("reopens every saved byte without replacing residents, tools, user records or the file", async () => {
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
    const before = await stat(workingImagePath);
    const prepared = await prepareNativeCpm22WorkingImage({
      repositoryRoot: root,
      workingImagePath,
      outputDirectory,
    });
    const saved = new Uint8Array(await readFile(workingImagePath));
    expect(prepared.diskPath).toBe(workingImagePath);
    expect(saved).toEqual(disk);
    expect(prepared.workingImageSha256).toBe(prepared.sourceImageSha256);
    const after = await stat(workingImagePath);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    for (const name of ["EDIT.COM", "NUC.COM", "ATOM.COM", "WORK.TXT"]) {
      expect(readCpm22File(saved, name)).toEqual(readCpm22File(disk, name));
    }
  });

  it("reopens without consulting installed resident releases", async () => {
    const fixture = await directory();
    await mkdir(join(fixture, "roms/cpu"), { recursive: true });
    await cp(
      join(root, "roms/cpu/bootstrap.asm"),
      join(fixture, "roms/cpu/bootstrap.asm"),
    );
    const workingImagePath = join(fixture, "saved.img");
    await writeFile(workingImagePath, canonical.disk);
    const prepared = await prepareNativeCpm22WorkingImage({
      repositoryRoot: fixture,
      workingImagePath,
      outputDirectory: fixture,
    });
    expect(new Uint8Array(await readFile(prepared.bootRomPath))).toEqual(
      canonical.bootstrap,
    );
    expect(new Uint8Array(await readFile(workingImagePath))).toEqual(
      canonical.disk,
    );
  });

  it("requires an explicit resident bootstrap profile for large media and preserves all eight MiB", async () => {
    const outputDirectory = await directory();
    const workingImagePath = join(outputDirectory, "large.img");
    const saved = Buffer.alloc(8_388_608, 0x59);
    // Distinct arbitrary saved residents are not the installed release.
    saved.fill(0x63, 0, 16384);
    await writeFile(workingImagePath, saved);
    await expect(
      prepareNativeCpm22WorkingImage({
        repositoryRoot: root,
        workingImagePath,
        outputDirectory,
      }),
    ).rejects.toThrow(/profile/i);
    expect((await readFile(workingImagePath)).equals(saved)).toBe(true);
    for (const [bootstrapProfile, source] of [
      ["triptych-cpu-v0.1-8m-a", "bootstrap.asm"],
      ["triptych-cpu-v0.1-8m-ab", "bootstrap-8m-ab.asm"],
    ]) {
      const prepared = await prepareNativeCpm22WorkingImage({
        repositoryRoot: root,
        workingImagePath,
        outputDirectory: await directory(),
        bootstrapProfile,
      });
      expect((await readFile(workingImagePath)).equals(saved)).toBe(true);
      expect(prepared.bootstrapProfile).toBe(bootstrapProfile);
      expect(new Uint8Array(await readFile(prepared.bootRomPath))).toEqual(
        await assembleAtomBinary(join(root, "roms/cpu", source)),
      );
      expect(prepared.workingImageSha256).toBe(prepared.sourceImageSha256);
    }
  });

  it("rejects unsupported profiles, misaligned images and persistent CCP replacement without mutation", async () => {
    const outputDirectory = await directory();
    const workingImagePath = join(outputDirectory, "saved.img");
    await writeFile(workingImagePath, canonical.disk);
    const args = { repositoryRoot: root, workingImagePath, outputDirectory };
    await expect(
      prepareNativeCpm22WorkingImage({ ...args, bootstrapProfile: "unknown" }),
    ).rejects.toThrow(/profile/i);
    await expect(
      prepareNativeCpm22WorkingImage({ ...args, systemCcp: "triptych" }),
    ).rejects.toThrow(/saved|persistent/i);
    expect(new Uint8Array(await readFile(workingImagePath))).toEqual(
      canonical.disk,
    );
    const short = canonical.disk.slice(0, -1);
    await writeFile(workingImagePath, short);
    await expect(prepareNativeCpm22WorkingImage(args)).rejects.toThrow(
      /512-byte|profile/i,
    );
    expect(new Uint8Array(await readFile(workingImagePath))).toEqual(short);
  });

  it("refuses bootstrap output aliases without touching saved bytes", async () => {
    const outputDirectory = await directory();
    const workingImagePath = join(outputDirectory, "saved.img");
    await writeFile(workingImagePath, canonical.disk);
    await symlink(workingImagePath, join(outputDirectory, "bootstrap.bin"));
    await expect(
      prepareNativeCpm22WorkingImage({
        repositoryRoot: root,
        workingImagePath,
        outputDirectory,
      }),
    ).rejects.toThrow(/EEXIST/);
    expect(new Uint8Array(await readFile(workingImagePath))).toEqual(
      canonical.disk,
    );
  });

  it("prepares optional drive B only under explicit A/B profile and preserves both saved images", async () => {
    const outputDirectory = await directory();
    const paths = ["a.img", "b.img"].map((name) => join(outputDirectory, name));
    const images = [Buffer.alloc(8388608, 0x41), Buffer.alloc(8388608, 0x42)];
    await Promise.all(paths.map((path, i) => writeFile(path, images[i])));
    const before = await Promise.all(paths.map((path) => stat(path)));
    const prepared = await prepareNativeCpm22WorkingImage({
      repositoryRoot: root,
      workingImagePath: paths[0],
      workingImagePathB: paths[1],
      outputDirectory,
      bootstrapProfile: "triptych-cpu-v0.1-8m-ab",
    });
    expect(prepared.diskPaths).toEqual(paths);
    expect(prepared.diskPath).toBe(paths[0]);
    expect(prepared.drives.map((drive) => drive.letter)).toEqual(["A", "B"]);
    expect(prepared.drives[0].sha256).toBe(prepared.sourceImageSha256);
    expect(prepared.drives[1].sha256).not.toBe(prepared.sourceImageSha256);
    for (const [i, path] of paths.entries()) {
      expect((await readFile(path)).equals(images[i])).toBe(true);
      const after = await stat(path);
      expect(after.ino).toBe(before[i].ino);
      expect(after.mtimeMs).toBe(before[i].mtimeMs);
    }
  });

  it.each([undefined, "triptych-cpu-v0.1", "triptych-cpu-v0.1-8m-a"])(
    "rejects drive B without explicit A/B profile: %s",
    async (bootstrapProfile) => {
      const outputDirectory = await directory();
      await expect(
        prepareNativeCpm22WorkingImage({
          repositoryRoot: root,
          workingImagePath: join(outputDirectory, "absent-a.img"),
          workingImagePathB: join(outputDirectory, "absent-b.img"),
          outputDirectory,
          bootstrapProfile,
        }),
      ).rejects.toThrow(/drive B requires.*8m-ab/i);
      expect(await readdir(outputDirectory)).toEqual([]);
    },
  );

  it.each([0, 512, 8388607, 8389120])(
    "rejects drive B capacity %i before writing artifacts",
    async (length) => {
      const outputDirectory = await directory();
      const a = join(outputDirectory, "a.img"),
        b = join(outputDirectory, "b.img");
      const originalA = Buffer.alloc(8388608, 0x41),
        originalB = Buffer.alloc(length, 0x42);
      await Promise.all([writeFile(a, originalA), writeFile(b, originalB)]);
      await expect(
        prepareNativeCpm22WorkingImage({
          repositoryRoot: root,
          workingImagePath: a,
          workingImagePathB: b,
          outputDirectory,
          bootstrapProfile: "triptych-cpu-v0.1-8m-ab",
        }),
      ).rejects.toThrow(/drive B.*(length|sector)/i);
      expect((await readFile(a)).equals(originalA)).toBe(true);
      expect((await readFile(b)).equals(originalB)).toBe(true);
      expect((await readdir(outputDirectory)).sort()).toEqual([
        "a.img",
        "b.img",
      ]);
    },
  );

  it.each(["same", "relative", "symlink", "hardlink"])(
    "rejects A/B disk aliases: %s",
    async (kind) => {
      const outputDirectory = await directory();
      const a = join(outputDirectory, "a.img");
      const original = Buffer.alloc(8388608, 0x41);
      await writeFile(a, original);
      let b = a;
      if (kind === "relative") b = `${outputDirectory}/./a.img`;
      if (kind === "symlink" || kind === "hardlink") {
        b = join(outputDirectory, "b.img");
        await (kind === "symlink" ? symlink(a, b) : link(a, b));
      }
      await expect(
        prepareNativeCpm22WorkingImage({
          repositoryRoot: root,
          workingImagePath: a,
          workingImagePathB: b,
          outputDirectory,
          bootstrapProfile: "triptych-cpu-v0.1-8m-ab",
        }),
      ).rejects.toThrow(/distinct|same file/i);
      expect((await readFile(a)).equals(original)).toBe(true);
      expect(await readdir(outputDirectory)).not.toContain("bootstrap.bin");
    },
  );

  it("requires an explicit source for historical CCP selection", async () => {
    await expect(
      prepareNativeCpm22Image({
        repositoryRoot: root,
        outputDirectory: await directory(),
        systemCcp: "oracle",
      }),
    ).rejects.toThrow(/explicit source/i);
  });

  it.each([
    [{ TRIPTYCH_CPM22_WORK_DISK_B: "b.img" }, /drive B requires.*WORK_DISK/i],
    [
      {
        TRIPTYCH_CPM22_WORK_DISK: "a.img",
        TRIPTYCH_CPM22_WORK_DISK_B: "b.img",
      },
      /drive B requires.*8m-ab/i,
    ],
    [
      { TRIPTYCH_CPM22_WORK_DISK: "saved.img", TRIPTYCH_CPM_CCP: "triptych" },
      /cannot replace the CCP/,
    ],
    [
      {
        TRIPTYCH_CPM22_WORK_DISK: "saved.img",
        TRIPTYCH_CPM22_IMAGE: "source.img",
      },
      /choose either/,
    ],
    [
      { TRIPTYCH_CPM_BOOTSTRAP_PROFILE: "triptych-cpu-v0.1-8m-ab" },
      /saved TRIPTYCH_CPM22_WORK_DISK only/,
    ],
  ])(
    "rejects conflicting launcher selection %j before starting a host",
    (selection, message) => {
      const environment = { ...process.env };
      for (const name of [
        "TRIPTYCH_CPM22_WORK_DISK",
        "TRIPTYCH_CPM22_WORK_DISK_B",
        "TRIPTYCH_CPM22_IMAGE",
        "TRIPTYCH_CPM_CCP",
        "TRIPTYCH_CPM_BOOTSTRAP_PROFILE",
      ])
        delete environment[name];
      const result = spawnSync(
        process.execPath,
        [join(root, "tools/run-cpm22-native.mjs")],
        {
          env: { ...environment, ...selection },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(result.stdout).not.toContain("Triptych native CP/M");
    },
  );
});
