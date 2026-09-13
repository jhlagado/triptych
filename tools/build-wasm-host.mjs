import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";
import { buildBrowserToolCatalog } from "./lib/browser-tool-catalog.mjs";
import { buildColossalCaveImage } from "./build-colossal-cave-image.mjs";
import {
  appendColossalCaveLibrary,
  buildColossalCaveDirectLaunch,
} from "./lib/colossal-cave-library.mjs";
import { buildTwoMibSystem } from "./lib/two-mib-system.mjs";
import { captureDiskLibraryRelease } from "./lib/disk-library-release.mjs";
import {
  readDiskLibraryPackage,
  retainPublishedImageMetadata,
} from "./lib/disk-library-package.mjs";
import { mergeDiskLibraryRetention } from "./lib/disk-library-retention.mjs";
import {
  diskLibraryBuildMode,
  selectDiskLibraryBuild,
} from "./lib/disk-library-build-guard.mjs";
import {
  buildPublicDriveDistribution,
  buildDiskLibraryDistribution,
  buildGamesDirectLaunch,
} from "./lib/public-drive-distribution.mjs";
import {
  buildLargeDiskSystem,
  LARGE_DISK_SYSTEM_ASSET,
} from "./lib/large-disk-system.mjs";
import {
  buildLargeAbSystem,
  LARGE_AB_SYSTEM_ASSET,
  LARGE_AB_BOOTSTRAP_ASSET,
} from "./lib/large-ab-system.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const browser = process.argv.includes("--browser");
const refreshDiskLibrary = process.argv.includes("--refresh-disk-library");
const release = process.argv.includes("--release");
const conformance = process.argv.includes("--conformance");
if (refreshDiskLibrary && !browser)
  throw new Error("disk-library refresh requires a browser candidate build");
if (browser && conformance) {
  throw new Error("browser and conformance builds are separate outputs");
}
// Validate publication policy before cargo, tuple generation or output staging.
// The same captured package is selected below; no later read can replace it.
const previousLibrary = browser
  ? await readDiskLibraryPackage(
      join(repositoryRoot, "distribution", "disk-library"),
    )
  : undefined;
const libraryBuildMode = diskLibraryBuildMode({
  browser,
  release,
  refresh: refreshDiskLibrary,
  previous: previousLibrary,
});
const outputDirectory = join(
  repositoryRoot,
  "dist",
  browser ? "wasm-browser" : "wasm",
);
const wasmPath = join(
  repositoryRoot,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "triptych_host_wasm.wasm",
);
const wasmBindgen = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const expectedVersion = "wasm-bindgen 0.2.127";

function run(command, commandArguments) {
  const result = spawnSync(command, commandArguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      result.error?.message ??
        result.stderr ??
        result.stdout ??
        `${command} failed`,
    );
  }
  return result.stdout.trim();
}

const cargoArguments = [
  "build",
  "--locked",
  "-p",
  "triptych-host-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
];
if (conformance) cargoArguments.push("--features", "conformance");
run("cargo", cargoArguments);

const version = run(wasmBindgen, ["--version"]);
if (version !== expectedVersion) {
  throw new Error(
    `expected ${expectedVersion}, got ${JSON.stringify(version)}; set WASM_BINDGEN to the pinned executable`,
  );
}

await mkdir(join(repositoryRoot, "dist"), { recursive: true });
const stagingRoot = await mkdtemp(join(repositoryRoot, "dist", ".wasm-build-"));
const stagedOutput = join(stagingRoot, "output");
await mkdir(stagedOutput);
let retainStaging = false;
try {
  run(wasmBindgen, [
    wasmPath,
    "--out-dir",
    stagedOutput,
    "--target",
    browser ? "web" : "nodejs",
    "--typescript",
  ]);
  if (browser) {
    const sourceDirectory = join(
      repositoryRoot,
      "crates",
      "triptych-host-wasm",
      "web",
    );
    const distribution = await buildCpmDistribution(repositoryRoot, {
      allowDirty: !process.argv.includes("--release"),
    });
    const systemDisk = distribution.disk;
    const largeSystem = await buildLargeDiskSystem(
      repositoryRoot,
      distribution,
    );
    const tools = buildBrowserToolCatalog(distribution.manifest, systemDisk);
    const largeAbSystem = await buildLargeAbSystem(
      repositoryRoot,
      distribution,
    );
    const twoMibProfiles = [];
    let librarySystem;
    // Build and stage one tuple at a time. Retain N4 for the library images;
    // private source/assembly evidence is not duplicated in the served assets.
    for (let configuredCount = 1; configuredCount <= 16; configuredCount++) {
      const tuple = await buildTwoMibSystem(repositoryRoot, configuredCount, {
        allowDirty: !process.argv.includes("--release"),
      });
      const { descriptor } = tuple;
      assert.deepEqual(
        {
          revision: descriptor.machine.revision,
          dirty: descriptor.machine.dirty,
        },
        distribution.manifest.triptych,
        "two-MiB and default distribution source identity",
      );
      const { packageIntegrity, ...atom } = descriptor.atom;
      assert.deepEqual(
        atom,
        distribution.manifest.atom,
        "two-MiB and default distribution ATOM identity",
      );
      const first = twoMibProfiles[0];
      if (first) {
        for (const [actual, expected, label] of [
          [
            packageIntegrity,
            first.atom.packageIntegrity,
            "ATOM package integrity",
          ],
          [
            descriptor.machine.generatorSha256,
            first.machine.generatorSha256,
            "generator",
          ],
          [
            descriptor.bios.sourceSha256,
            first.bios.sourceSha256,
            "BIOS source",
          ],
          [
            descriptor.bootstrap.sourceSha256,
            first.bootstrap.sourceSha256,
            "bootstrap source",
          ],
          [
            descriptor.residents.ccp.sourceSha256,
            first.residents.ccp.sourceSha256,
            "CCP source",
          ],
          [
            descriptor.residents.bdos.sourceSha256,
            first.residents.bdos.sourceSha256,
            "BDOS source",
          ],
        ])
          assert.equal(actual, expected, `one two-MiB family ${label}`);
      }
      await Promise.all([
        writeFile(join(stagedOutput, descriptor.system.asset), tuple.system, {
          flag: "wx",
        }),
        writeFile(
          join(stagedOutput, descriptor.bootstrap.asset),
          tuple.bootstrap,
          { flag: "wx" },
        ),
      ]);
      twoMibProfiles.push(descriptor);
      if (configuredCount === 4)
        librarySystem = {
          system: tuple.system,
          bootstrap: tuple.bootstrap,
          descriptor,
          residentLockBytes: tuple.evidence.lockBytes,
        };
    }
    const { CpmDisk, initSync } = await import(
      pathToFileURL(join(stagedOutput, "triptych_host_wasm.js")).href
    );
    initSync({
      module: await readFile(join(stagedOutput, "triptych_host_wasm_bg.wasm")),
    });
    const publicDistribution = buildPublicDriveDistribution({
      distribution,
      largeAbSystem,
      CpmDisk,
    });
    const baseLibrary = buildDiskLibraryDistribution({
      distribution,
      twoMibSystem: librarySystem,
      componentLockBytes: await readFile(
        join(repositoryRoot, "distribution/components.lock.json"),
      ),
      CpmDisk,
    });
    const colossalCave = await buildColossalCaveImage({ CpmDisk });
    const library = appendColossalCaveLibrary(baseLibrary, colossalCave);
    const directLaunch = buildColossalCaveDirectLaunch({
      library: baseLibrary,
      cave: colossalCave,
      CpmDisk,
    });
    const gamesLaunch = buildGamesDirectLaunch({
      library: baseLibrary,
      CpmDisk,
    });
    directLaunch.descriptor.launches.push(gamesLaunch.descriptor);
    // Identical image bytes keep their first publication's source reference.
    // A later machine build may have a new revision without changing that disk.
    // Other metadata changes under the same immutable identity are errors.
    library.catalogue.images = retainPublishedImageMetadata(
      previousLibrary.manifest.images,
      library.catalogue.images,
    );
    const libraryCatalogueBytes = Buffer.from(
      `${JSON.stringify(library.catalogue, null, 2)}\n`,
    );
    const libraryProvenanceBytes = Buffer.from(
      `${JSON.stringify(library.provenance, null, 2)}\n`,
    );
    const libraryAdmissionBytes = Buffer.from(
      `${JSON.stringify(
        {
          schema: "triptych-browser-deployment-v1",
          twoMibProfiles: [librarySystem.descriptor],
          assets: [
            librarySystem.descriptor.system,
            librarySystem.descriptor.bootstrap,
          ].map(({ asset, bytes, sha256 }) => ({ path: asset, bytes, sha256 })),
        },
        null,
        2,
      )}\n`,
    );
    const blankLibraryDisk = CpmDisk.create_two_mib();
    let retainedLibrary;
    try {
      retainedLibrary = captureDiskLibraryRelease({
        catalogueBytes: libraryCatalogueBytes,
        provenanceBytes: libraryProvenanceBytes,
        admissionBytes: libraryAdmissionBytes,
        assets: new Map([
          ...library.images.map(({ asset, bytes }) => [asset, bytes]),
          [librarySystem.descriptor.system.asset, librarySystem.system],
          [librarySystem.descriptor.bootstrap.asset, librarySystem.bootstrap],
        ]),
        blankSeed: blankLibraryDisk.export_source(),
      });
    } finally {
      blankLibraryDisk.free();
    }
    // Pinning a release changes the repository revision. Normal builds must
    // not turn that bookkeeping commit into another unpinned recipe revision.
    // Only an explicit candidate refresh adds releases to a nonempty registry.
    retainedLibrary = selectDiskLibraryBuild(
      libraryBuildMode,
      previousLibrary,
      retainedLibrary,
      mergeDiskLibraryRetention,
    );
    const bootRom = distribution.bootstrap;
    const ccp = systemDisk.slice(0, 0x800);
    const bdos = systemDisk.slice(0x800, 0x1600);
    const bios = systemDisk.slice(0x1600, 0x1a00);
    await Promise.all([
      copyFile(
        join(sourceDirectory, "index.html"),
        join(stagedOutput, "index.html"),
      ),
      copyFile(join(sourceDirectory, "app.js"), join(stagedOutput, "app.js")),
      ...[
        "favicon.svg",
        "favicon.png",
        "apple-touch-icon.png",
        "disk-workspace.js",
        "disk-profile.js",
        "two-mib-system.js",
        "drive-set-v4.js",
        "drive-set.js",
        "drive-set-store.js",
        "saved-machine.js",
        "saved-machine-store.js",
        "disk-box.js",
        "disk-box-adoption.js",
        "disk-box-runtime.js",
        "disk-box-media-change.js",
        "disk-launch.js",
        "direct-launch.js",
        "disk-box-store.js",
        "disk-box-app-store.js",
        "disk-box-recovery.js",
        "disk-catalogue.js",
        "disk-library-registry.js",
        "saved-machine-workspace.js",
        "saved-machine-runtime.js",
        "saved-machine-configuration.js",
        "working-disk-revisions.js",
        "tool-catalog.js",
        "source-bundle.js",
        "public-distribution.js",
      ].map((path) =>
        copyFile(join(sourceDirectory, path), join(stagedOutput, path)),
      ),
      copyFile(
        join(sourceDirectory, "working-disk-store.js"),
        join(stagedOutput, "working-disk-store.js"),
      ),
      copyFile(
        join(sourceDirectory, "terminal.js"),
        join(stagedOutput, "terminal.js"),
      ),
      copyFile(
        join(sourceDirectory, "style.css"),
        join(stagedOutput, "style.css"),
      ),
      writeFile(join(stagedOutput, "bootstrap.bin"), bootRom),
      writeFile(join(stagedOutput, "ccp.bin"), ccp),
      writeFile(join(stagedOutput, "bdos.bin"), bdos),
      writeFile(join(stagedOutput, "bios.bin"), bios),
      writeFile(join(stagedOutput, LARGE_DISK_SYSTEM_ASSET), largeSystem.bytes),
      writeFile(join(stagedOutput, LARGE_AB_SYSTEM_ASSET), largeAbSystem.bytes),
      writeFile(
        join(stagedOutput, LARGE_AB_BOOTSTRAP_ASSET),
        largeAbSystem.bootstrap,
      ),
      writeFile(join(stagedOutput, "cpm22.img"), systemDisk),
      ...library.images.map(({ asset, bytes }) =>
        writeFile(join(stagedOutput, asset), bytes, { flag: "wx" }),
      ),
      writeFile(
        join(stagedOutput, "disk-catalogue.json"),
        libraryCatalogueBytes,
        { flag: "wx" },
      ),
      writeFile(
        join(stagedOutput, "disk-library-provenance.json"),
        libraryProvenanceBytes,
        { flag: "wx" },
      ),
      writeFile(
        join(stagedOutput, directLaunch.image.asset),
        directLaunch.image.bytes,
        { flag: "wx" },
      ),
      writeFile(
        join(stagedOutput, gamesLaunch.image.asset),
        gamesLaunch.image.bytes,
        { flag: "wx" },
      ),
      writeFile(
        join(stagedOutput, "direct-games-provenance.json"),
        `${JSON.stringify(gamesLaunch.provenance, null, 2)}\n`,
        { flag: "wx" },
      ),
      writeFile(
        join(stagedOutput, "direct-launch-provenance.json"),
        `${JSON.stringify(directLaunch.provenance, null, 2)}\n`,
        { flag: "wx" },
      ),
      ...Object.entries(publicDistribution.drives).map(([letter, drive]) =>
        writeFile(
          join(stagedOutput, publicDistribution.descriptor.drives[letter].path),
          drive.bytes,
        ),
      ),
      writeFile(
        join(stagedOutput, "tool-catalog.json"),
        `${JSON.stringify(tools.catalog, null, 2)}\n`,
      ),
      ...[...tools.assets].map(([path, bytes]) =>
        writeFile(join(stagedOutput, path), bytes),
      ),
      ...["IO.NU", "MAIN.NU", "BUILD.JSN"].map((name) =>
        copyFile(
          join(repositoryRoot, "samples/nucleus-adventure", name),
          join(stagedOutput, `adventure-${name}`),
        ),
      ),
      writeFile(
        join(stagedOutput, "config.json"),
        `${JSON.stringify(
          {
            diskUrl: "cpm22.img",
            diskName: "triptych-cpm22.img",
            systemCcp: "triptych",
            publicDrives: true,
          },
          undefined,
          2,
        )}\n`,
        "utf8",
      ),
      writeFile(join(stagedOutput, ".nojekyll"), "", "utf8"),
    ]);
    // Image files already exist above. Compare duplicate paths instead of
    // overwriting them; every additional retained asset is created exactly once.
    for (const [path, bytes] of retainedLibrary.assets) {
      try {
        await writeFile(join(stagedOutput, path), bytes, { flag: "wx" });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        assert.deepEqual(
          new Uint8Array(await readFile(join(stagedOutput, path))),
          bytes,
          `retained library asset collision: ${path}`,
        );
      }
    }
    await writeFile(
      join(stagedOutput, "disk-library-registry.json"),
      `${JSON.stringify(retainedLibrary.manifest, null, 2)}\n`,
      { flag: "wx" },
    );
    const assets = [];
    for (const path of (await readdir(stagedOutput)).sort()) {
      const bytes = await readFile(join(stagedOutput, path));
      assets.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await writeFile(
      join(stagedOutput, "deployment-manifest.json"),
      `${JSON.stringify(
        {
          schema: "triptych-browser-deployment-v1",
          storageSchema: "triptych-disk-box-v1",
          distribution: distribution.manifest,
          diskProfiles: [largeSystem.profile, largeAbSystem.profile],
          twoMibProfiles,
          directLaunches: directLaunch.descriptor,
          publicDrives: publicDistribution.descriptor,
          host: {
            wasmBindgen: version,
            cargoLockSha256: createHash("sha256")
              .update(await readFile(join(repositoryRoot, "Cargo.lock")))
              .digest("hex"),
          },
          assets,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    await writeFile(
      join(stagedOutput, "package.json"),
      `${JSON.stringify({ type: "commonjs" }, undefined, 2)}\n`,
      "utf8",
    );
  }

  const previousOutput = join(stagingRoot, "previous");
  let movedPrevious = false;
  try {
    await rename(outputDirectory, previousOutput);
    movedPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagedOutput, outputDirectory);
  } catch (error) {
    if (movedPrevious) {
      try {
        await rename(previousOutput, outputDirectory);
      } catch (restoreError) {
        retainStaging = true;
        throw new AggregateError(
          [error, restoreError],
          `Could not restore the previous build; retained at ${previousOutput}`,
        );
      }
    }
    throw error;
  }
} finally {
  if (!retainStaging) await rm(stagingRoot, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    status: "built",
    crate: "triptych-host-wasm",
    target: "wasm32-unknown-unknown",
    wasmBindgen: version,
    conformance,
    browser,
    outputDirectory,
  }),
);
