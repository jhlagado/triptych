import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readCpm22File } from "./cpm22-disk.mjs";
import {
  LARGE_AB_PROFILE,
  LARGE_AB_BOOTSTRAP_ASSET,
} from "./large-ab-system.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const GAMES = [
  ["caverns80", "CAVERNS.COM"],
  ["hyperdrive", "HYPERDRV.COM"],
];
const README = Buffer.from(
  "TRIPTYCH GAMES\r\n\r\n" +
    "At the CP/M prompt, select the games drive:\r\n" +
    "B:\r\n\r\n" +
    "Then run either game:\r\n" +
    "CAVERNS\r\n" +
    "HYPERDRV\r\n\r\n" +
    "Return to drive A for ATOM, NUC, EDIT and source samples.\r\n",
  "ascii",
);

/** Construct private fresh A/B media from already verified build inputs.
 * This helper neither reads saved media nor adapts an existing machine.
 * Filesystem allocation belongs exclusively to the Rust CpmDisk API.
 */
export function buildPublicDriveDistribution({
  distribution,
  largeAbSystem,
  CpmDisk,
}) {
  const { disk, manifest } = distribution;
  const { bytes: system, bootstrap, profile } = largeAbSystem;
  assert.equal(manifest.targetProfile, "triptych-cpu-v0.1");
  assert.equal(disk.length, 256512);
  assert.equal(disk.length, manifest.disk.bytes);
  assert.equal(hash(disk), manifest.disk.sha256, "source distribution digest");
  assert.equal(profile.residentProfile, LARGE_AB_PROFILE);
  assert.equal(profile.bootstrapAsset, LARGE_AB_BOOTSTRAP_ASSET);
  assert.equal(profile.imageBytes, 8388608);
  assert.equal(profile.drives, 2);
  assert.equal(profile.systemBytes, 16384);
  assert.equal(system.length, profile.systemBytes);
  assert.equal(hash(system), profile.systemSha256, "A/B system digest");
  assert.equal(bootstrap.length, 256);
  assert.equal(
    hash(bootstrap),
    profile.bootstrapSha256,
    "A/B bootstrap digest",
  );

  const source = new CpmDisk(disk);
  let files;
  try {
    files = source
      .file_names()
      .sort()
      .map((name) => ({
        name,
        bytes: readCpm22File(disk, name),
      }));
  } finally {
    source.free();
  }
  const games = GAMES.map(([id, name]) => {
    const components = manifest.components.filter((entry) => entry.id === id);
    assert.equal(components.length, 1, `one ${id} component`);
    const component = components[0];
    assert.equal(component.install.kind, "file");
    assert.equal(component.install.name, name, `${id} install identity`);
    assert(Number.isSafeInteger(component.bytes) && component.bytes > 0);
    assert(Number.isInteger(component.install.padByte));
    assert(component.install.padByte >= 0 && component.install.padByte <= 255);
    const file = files.find((entry) => entry.name === name);
    assert(file, `${name} source file`);
    assert.equal(file.bytes.length, Math.ceil(component.bytes / 128) * 128);
    assert.equal(
      hash(file.bytes.subarray(0, component.bytes)),
      component.sha256,
      `${name} released component digest`,
    );
    assert(
      file.bytes
        .subarray(component.bytes)
        .every((byte) => byte === component.install.padByte),
      `${name} record padding`,
    );
    return file;
  });
  for (const name of ["ATOM.COM", "NUC.COM", "EDIT.COM"])
    assert(
      files.some((file) => file.name === name),
      `${name} system tool`,
    );

  const create = (imports, systemArea) => {
    const blank = CpmDisk.create_eight_mib();
    try {
      for (const file of imports) blank.add_import(file.name, file.bytes);
      const bytes = Uint8Array.from(blank.export_candidate());
      assert.equal(bytes.length, profile.imageBytes);
      assert(
        bytes.subarray(0, profile.systemBytes).every((byte) => byte === 0),
      );
      if (systemArea) bytes.set(systemArea);
      return bytes;
    } finally {
      blank.free();
    }
  };
  const drives = {
    A: {
      name: "drive-a-system.img",
      bytes: create(
        files.filter((file) => !games.includes(file)),
        system,
      ),
    },
    B: {
      name: "drive-b-games.img",
      bytes: create([...games, { name: "README.TXT", bytes: README }]),
    },
  };
  const descriptor = {
    schema: "triptych-public-drives-v1",
    profile: profile.residentProfile,
    bootstrapAsset: profile.bootstrapAsset,
    drives: Object.fromEntries(
      Object.entries(drives).map(([letter, drive]) => [
        letter,
        {
          path: drive.name,
          name: drive.name,
          bytes: drive.bytes.length,
          sha256: hash(drive.bytes),
        },
      ]),
    ),
  };
  return { drives, descriptor };
}
