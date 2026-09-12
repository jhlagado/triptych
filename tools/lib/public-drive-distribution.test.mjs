import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { before, describe, it } from "node:test";
import { readFile } from "node:fs/promises";
import { buildCpmDistribution } from "./cpm-distribution.mjs";
import { buildLargeAbSystem } from "./large-ab-system.mjs";
import { buildTwoMibSystem } from "./two-mib-system.mjs";
import {
  buildPublicDriveDistribution,
  buildDiskLibraryDistribution,
} from "./public-drive-distribution.mjs";
import { installCpm22File, readCpm22File } from "./cpm22-disk.mjs";

const root = resolve(import.meta.dirname, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const games = ["CAVERNS.COM", "HYPERDRV.COM"];

describe("published two-MiB library from qualified source fixtures", () => {
  let distribution, twoMibSystem, componentLockBytes, CpmDisk;
  before(async () => {
    ({ CpmDisk } = await import(
      pathToFileURL(resolve(root, "dist/wasm/triptych_host_wasm.js")).href
    ));
    // The clean gate prepares Node WASM before these tests, but the browser
    // build comes later. Assemble pinned source fixtures in memory through the
    // production helpers, without reading or writing browser output artifacts.
    distribution = await buildCpmDistribution(root, { allowDirty: true });
    const qualified = await buildTwoMibSystem(root, 4, { allowDirty: true });
    const descriptor = qualified.descriptor;
    twoMibSystem = {
      descriptor,
      system: qualified.system,
      bootstrap: qualified.bootstrap,
      residentLockBytes: await readFile(
        resolve(root, descriptor.residents.lock),
      ),
    };
    componentLockBytes = await readFile(
      resolve(root, "distribution/components.lock.json"),
    );
  });
  const build = (overrides = {}) =>
    buildDiskLibraryDistribution({
      distribution,
      twoMibSystem,
      componentLockBytes,
      CpmDisk,
      ...overrides,
    });

  it("emits exact N4 system and data-only games with verified file provenance", () => {
    const output = build();
    assert.equal(output.catalogue.images.length, 2);
    for (const [index, image] of output.images.entries()) {
      const row = output.catalogue.images[index];
      assert.equal(image.bytes.length, 2097152);
      assert.equal(row.sha256, hash(image.bytes));
      assert.equal(row.revision, row.sha256);
      assert(image.asset.includes(row.sha256));
      assert.equal(row.geometry, "triptych-cpm-2m-v1");
      const disk = new CpmDisk(image.bytes);
      try {
        assert.equal(disk.geometry_id(), row.geometry);
        if (index === 0) {
          assert.deepEqual(
            image.bytes.subarray(0, 16384),
            Uint8Array.from(twoMibSystem.system),
          );
          assert.equal(row.systemProfile, "triptych-cpu-v0.1-2m-n04");
          assert(!disk.file_names().some((name) => games.includes(name)));
          for (const name of [
            "ATOM.COM",
            "NUC.COM",
            "EDIT.COM",
            "HELLO.ASM",
            "INPUT.NU",
            "LARGE.ASM",
          ])
            assert.deepEqual(
              Buffer.from(disk.read_file(name)),
              Buffer.from(readCpm22File(distribution.disk, name)),
            );
        } else {
          assert.equal(row.systemProfile, null);
          assert(image.bytes.subarray(0, 16384).every((byte) => byte === 0));
          assert.deepEqual(
            disk.file_names().sort(),
            [...games, "README.TXT"].sort(),
          );
          for (const name of games)
            assert.deepEqual(
              Buffer.from(disk.read_file(name)),
              Buffer.from(readCpm22File(distribution.disk, name)),
            );
          assert.match(
            Buffer.from(disk.read_file("README.TXT")).toString("ascii"),
            /current CP\/M drive/,
          );
        }
      } finally {
        disk.free();
      }
    }
    assert.equal(output.bootstrap.sha256, hash(twoMibSystem.bootstrap));
    assert.equal(
      output.provenance.system.residentProfile,
      output.bootstrap.profile,
    );
    for (const game of ["caverns80", "hyperdrive"])
      assert.equal(
        output.provenance.components.find((component) => component.id === game)
          .licence.spdx,
        "GPL-3.0-only",
      );
    assert.equal(output.provenance.samples.length, 3);
  });

  it("owns deterministic independent outputs without changing inputs", () => {
    const before = structuredClone({ distribution, twoMibSystem });
    const first = build(),
      second = build();
    assert.deepEqual(first, second);
    first.images[0].bytes.fill(9);
    assert.equal(
      hash(second.images[0].bytes),
      second.catalogue.images[0].sha256,
    );
    assert.equal(hash(first.images[1].bytes), first.catalogue.images[1].sha256);
    assert.deepEqual(structuredClone({ distribution, twoMibSystem }), before);
  });

  for (const damage of [
    "count",
    "profile",
    "system",
    "bootstrap",
    "component-lock",
    "resident-lock",
    "game-pin",
  ])
    it(`rejects changed library ${damage}`, () => {
      const changed = structuredClone({
        distribution,
        twoMibSystem,
        componentLockBytes,
      });
      if (damage === "count")
        changed.twoMibSystem.descriptor.configuredCount = 3;
      if (damage === "profile")
        changed.twoMibSystem.descriptor.residentProfile =
          "triptych-cpu-v0.1-2m-n03";
      if (damage === "system") changed.twoMibSystem.system[0] ^= 1;
      if (damage === "bootstrap") changed.twoMibSystem.bootstrap[0] ^= 1;
      if (damage === "component-lock") changed.componentLockBytes[0] ^= 1;
      if (damage === "resident-lock")
        changed.twoMibSystem.residentLockBytes[0] ^= 1;
      if (damage === "game-pin")
        changed.distribution.manifest.components.find(
          (component) => component.id === "caverns80",
        ).sha256 = "0".repeat(64);
      assert.throws(() => build(changed));
    });
});

describe("fresh public system and games drives", () => {
  let distribution, largeAbSystem, CpmDisk;
  before(
    async () => {
      ({ CpmDisk } = await import(
        pathToFileURL(resolve(root, "dist/wasm/triptych_host_wasm.js")).href
      ));
      distribution = await buildCpmDistribution(root, { allowDirty: true });
      largeAbSystem = await buildLargeAbSystem(root, distribution);
    },
    { timeout: 120000 },
  );
  const build = (overrides = {}) =>
    buildPublicDriveDistribution({
      distribution,
      largeAbSystem,
      CpmDisk,
      ...overrides,
    });

  it("preserves exact record-padded tools and samples on A, with only games and instructions on data-only B", () => {
    const before = structuredClone({ distribution, largeAbSystem });
    const output = build();
    const source = new CpmDisk(distribution.disk);
    const a = new CpmDisk(output.drives.A.bytes);
    const b = new CpmDisk(output.drives.B.bytes);
    try {
      assert.deepEqual(
        a.file_names().sort(),
        source
          .file_names()
          .filter((name) => !games.includes(name))
          .sort(),
      );
      assert.deepEqual(b.file_names().sort(), [...games, "README.TXT"].sort());
      for (const name of source.file_names())
        assert.deepEqual(
          (games.includes(name) ? b : a).read_file(name),
          readCpm22File(distribution.disk, name),
          name,
        );
      for (const name of ["ATOM.COM", "NUC.COM", "EDIT.COM"])
        assert(a.file_names().includes(name));
      const readme = Buffer.from(b.read_file("README.TXT")).toString("ascii");
      assert.match(readme, /\r\nB:\r\n/);
      assert.match(readme, /\r\nCAVERNS\r\nHYPERDRV\r\n/);
      assert(readme.includes("Return to drive A"));
      assert.equal(a.geometry_id(), "triptych-cpm-8m-v1");
      assert.equal(b.geometry_id(), "triptych-cpm-8m-v1");
    } finally {
      source.free();
      a.free();
      b.free();
    }
    assert.deepEqual(
      output.drives.A.bytes.subarray(0, 16384),
      largeAbSystem.bytes,
    );
    assert(
      output.drives.B.bytes.subarray(0, 16384).every((byte) => byte === 0),
    );
    assert.deepEqual({ distribution, largeAbSystem }, before);
    assert.deepEqual(output.descriptor, {
      schema: "triptych-public-drives-v1",
      profile: "triptych-cpu-v0.1-8m-ab",
      bootstrapAsset: "bootstrap-triptych-cpm-8m-ab-v1.bin",
      drives: Object.fromEntries(
        ["A", "B"].map((letter) => {
          const drive = output.drives[letter];
          const name =
            letter === "A" ? "drive-a-system.img" : "drive-b-games.img";
          assert.equal(drive.name, name);
          assert.equal(drive.bytes.length, 8388608);
          return [
            letter,
            { path: name, name, bytes: 8388608, sha256: hash(drive.bytes) },
          ];
        }),
      ),
    });
  });

  it("builds deterministic independent media without aliasing either input or the other drive", () => {
    const first = build(),
      second = build();
    assert.deepEqual(first, second);
    assert.notEqual(first.drives.A.bytes.buffer, second.drives.A.bytes.buffer);
    assert.notEqual(first.drives.B.bytes.buffer, second.drives.B.bytes.buffer);
    assert.notEqual(first.drives.A.bytes.buffer, first.drives.B.bytes.buffer);
    const sourceHash = hash(distribution.disk),
      systemHash = hash(largeAbSystem.bytes);
    first.drives.A.bytes[0] ^= 255;
    first.drives.B.bytes[16384] ^= 255;
    for (const letter of ["A", "B"])
      assert.equal(
        hash(second.drives[letter].bytes),
        second.descriptor.drives[letter].sha256,
      );
    assert.equal(hash(distribution.disk), sourceHash);
    assert.equal(hash(largeAbSystem.bytes), systemHash);
  });

  for (const damage of ["digest", "name", "missing", "duplicate"])
    it(`rejects ${damage} game-component identity before publishing media`, () => {
      const changed = structuredClone(distribution);
      const game = changed.manifest.components.find(
        (entry) => entry.id === "caverns80",
      );
      if (damage === "digest") game.sha256 = "0".repeat(64);
      if (damage === "name") game.install.name = "OTHER.COM";
      if (damage === "missing")
        changed.manifest.components = changed.manifest.components.filter(
          (entry) => entry.id !== "caverns80",
        );
      if (damage === "duplicate")
        changed.manifest.components.push(structuredClone(game));
      const before = structuredClone(changed);
      assert.throws(() => build({ distribution: changed }));
      assert.deepEqual(changed, before);
    });

  for (const damage of ["game-byte", "record-padding"])
    it(`rejects changed ${damage} even when the whole source disk digest is updated`, () => {
      const changed = structuredClone(distribution);
      const component = changed.manifest.components.find(
        (entry) => entry.id === "caverns80",
      );
      const bytes = readCpm22File(changed.disk, "CAVERNS.COM");
      assert(
        bytes.length > component.bytes,
        "fixture exercises record padding",
      );
      bytes[damage === "game-byte" ? 0 : component.bytes] ^= 255;
      changed.disk = installCpm22File(changed.disk, {
        name: "CAVERNS.COM",
        bytes,
      });
      changed.manifest.disk.sha256 = hash(changed.disk);
      const before = changed.disk.slice();
      assert.throws(() => build({ distribution: changed }));
      assert.deepEqual(changed.disk, before);
    });

  for (const damage of ["profile", "system", "bootstrap", "asset"])
    it(`rejects mismatched A/B ${damage}`, () => {
      const changed = structuredClone(largeAbSystem);
      if (damage === "profile") changed.profile.residentProfile = "legacy-e400";
      if (damage === "system") changed.bytes[0] ^= 255;
      if (damage === "bootstrap") changed.bootstrap[0] ^= 255;
      if (damage === "asset") changed.profile.bootstrapAsset = "bootstrap.bin";
      const before = structuredClone(changed);
      assert.throws(() => build({ largeAbSystem: changed }));
      assert.deepEqual(changed, before);
    });
});
