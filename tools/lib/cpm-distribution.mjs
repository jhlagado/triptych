import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadNativeAtomCore } from "atom-z80";
import { assembleAtomFile } from "./assemble-atom.mjs";
import { validateComponentLock } from "./component-lock.mjs";
import { readVerifiedRelease } from "./verified-release.mjs";
import { validateDistributionManifest } from "./distribution-manifests.mjs";
import { createBlankCpm22Disk, installCpm22File } from "./cpm22-disk.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const exec = promisify(execFile);
const ATOM_IMAGE_SHA =
  "9121b6a37342d9c53fb7d05a0cfa9ba8c5429b34767ecef2df81bf8833c04954";
const ATOM_CENSUS_SHA =
  "0ac2e3b8863d80ac7d1bc0ace996a5838fd002af8e1ca2a288092bb1fb8cc50c";

/** Build private fresh media only. Never reads or updates a user's disk. */
export async function buildCpmDistribution(
  repositoryRoot,
  { allowDirty = false } = {},
) {
  const lockBytes = await readFile(
    join(repositoryRoot, "distribution/components.lock.json"),
  );
  const lock = validateComponentLock(JSON.parse(lockBytes), {
    recipes: new Set(["verified-release", "atom-binary", "atom-cpm22"]),
  });
  assert.equal(lock.targetProfile, "triptych-cpu-v0.1");
  assert.equal(
    lock.atom.repository,
    "https://github.com/jhlagado/atom.git",
    "ATOM repository",
  );
  assert.deepEqual(lock.disk, {
    bytes: 256512,
    recordBytes: 128,
    systemRecords: 52,
  });
  assert.deepEqual(
    lock.components.map((c) => c.id),
    ["ccp", "bdos", "bios", "atom", "nucleus", "edit"],
  );
  const packageBytes = await readFile(join(repositoryRoot, "package.json"));
  const npmLockBytes = await readFile(
    join(repositoryRoot, "package-lock.json"),
  );
  const spec = `git+${lock.atom.repository}#${lock.atom.revision}`;
  assert.equal(JSON.parse(packageBytes).devDependencies["atom-z80"], spec);
  const npmLock = JSON.parse(npmLockBytes);
  assert.equal(npmLock.packages[""].devDependencies["atom-z80"], spec);
  const installed = npmLock.packages["node_modules/atom-z80"];
  assert.equal(installed.resolved, spec, "installed ATOM lock identity");
  assert.ok(installed.integrity);
  const core = await loadNativeAtomCore();
  const seedBytes = await readFile(core.artifactPath);
  assert.equal(seedBytes.length, lock.atom.seed.bytes, "ATOM seed byte count");
  assert.equal(hash(seedBytes), lock.atom.seed.sha256, "ATOM seed digest");

  let disk = createBlankCpm22Disk();
  const outputs = [];
  for (const component of lock.components) {
    let bytes;
    if (component.recipe === "verified-release") {
      const verified = await readVerifiedRelease(repositoryRoot, component);
      validateDistributionManifest(
        component,
        verified.manifest,
        lock.atom.revision,
      );
      bytes = verified.bytes;
    } else if (component.id === "bios") {
      assert.equal(component.recipe, "atom-binary");
      assert.deepEqual(component.source, {
        kind: "triptych",
        path: "system/cpm/bios.asm",
      });
      assert.deepEqual(component.target, { origin: 0xfa00, capacity: 1024 });
      assert.deepEqual(component.install, {
        kind: "system-records",
        firstRecord: 44,
        recordCount: 8,
      });
      const assembled = await assembleAtomFile(
        join(repositoryRoot, component.source.path),
      );
      assert.equal(assembled.base, 0xfa00);
      assert.equal(assembled.bytes.length, 1024);
      bytes = assembled.bytes;
    } else {
      assert.equal(component.id, "atom");
      assert.equal(component.recipe, "atom-cpm22");
      assert.deepEqual(component.source, {
        kind: "git",
        repository: lock.atom.repository,
        revision: lock.atom.revision,
        path: "assets/atom-cpm22.com",
      });
      assert.deepEqual(component.target, { origin: 256, capacity: 0xe300 });
      assert.deepEqual(component.install, {
        kind: "file",
        name: "ATOM.COM",
        padByte: 26,
      });
      bytes = new Uint8Array(
        await readFile(new URL(import.meta.resolve("atom-z80/cpm22/image"))),
      );
      const censusBytes = await readFile(
        new URL(import.meta.resolve("atom-z80/cpm22/census")),
      );
      assert.equal(hash(censusBytes), ATOM_CENSUS_SHA, "ATOM census digest");
      const census = JSON.parse(censusBytes);
      assert.equal(bytes.length, 15033);
      assert.equal(hash(bytes), ATOM_IMAGE_SHA, "ATOM guest image digest");
      assert.equal(census.sha256, ATOM_IMAGE_SHA);
      assert.equal(census.loadAddress, 256);
      // The COM entry at 0100 jumps to the census's internal adapter entry.
      assert.equal(bytes[0], 0xc3);
      assert.equal(bytes[1] | (bytes[2] << 8), census.entryAddress);
    }
    if (component.install.kind === "system-records") {
      assert.equal(bytes.length, component.install.recordCount * 128);
      disk.set(bytes, component.install.firstRecord * 128);
    } else {
      disk = installCpm22File(disk, {
        name: component.install.name,
        bytes,
        padByte: component.install.padByte,
      });
    }
    outputs.push({
      id: component.id,
      bytes: bytes.length,
      sha256: hash(bytes),
      source: component.source,
      target: component.target,
      install: component.install,
    });
  }
  for (const name of ["HELLO.ASM", "INPUT.NU", "LARGE.ASM"]) {
    const source = await readFile(
      join(repositoryRoot, "distribution/samples", name),
      "utf8",
    );
    const bytes = Buffer.from(source.replace(/\r?\n/g, "\r\n"), "ascii");
    disk = installCpm22File(disk, { name, bytes, padByte: 26 });
    outputs.push({
      id: name,
      bytes: bytes.length,
      sha256: hash(bytes),
      source: { kind: "triptych", path: `distribution/samples/${name}` },
    });
  }
  const boot = await assembleAtomFile(
    join(repositoryRoot, "roms/cpu/bootstrap.asm"),
  );
  assert.equal(boot.base, 0);
  assert.equal(boot.bytes.length, 256);
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    exec("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    exec("git", ["status", "--porcelain"], { cwd: repositoryRoot }),
  ]);
  const dirty = status.length !== 0;
  assert.ok(
    allowDirty || !dirty,
    "release distribution requires a clean Triptych checkout",
  );
  return {
    disk,
    bootstrap: boot.bytes,
    manifest: {
      schema: "triptych-cpm-distribution-v1",
      triptych: { revision: revision.trim(), dirty },
      targetProfile: lock.targetProfile,
      lockSha256: hash(lockBytes),
      packageLockSha256: hash(npmLockBytes),
      atom: lock.atom,
      components: outputs,
      disk: { bytes: disk.length, logicalBytes: 256256, sha256: hash(disk) },
      bootstrap: { bytes: boot.bytes.length, sha256: hash(boot.bytes) },
    },
  };
}
