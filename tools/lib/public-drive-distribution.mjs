import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readCpm22File } from "./cpm22-disk.mjs";
import { validateComponentLock } from "./component-lock.mjs";
import { validateDiskCatalogue } from "../../crates/triptych-host-wasm/web/disk-catalogue.js";
import {
  LARGE_AB_PROFILE,
  LARGE_AB_BOOTSTRAP_ASSET,
} from "./large-ab-system.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Compose a bootable demo from the already verified system and games disks. */
export function buildGamesDirectLaunch({ library, CpmDisk }) {
  const source = (id) => {
    const row = library.catalogue.images.find((image) => image.id === id);
    assert(row, `missing ${id}`);
    const image = library.images.find((image) => image.asset === row.asset);
    assert.equal(hash(image.bytes), row.sha256);
    return image.bytes;
  };
  const system = source("system-2m-n04");
  const games = new CpmDisk(source("games-2m"));
  const disk = new CpmDisk(system);
  let bytes;
  try {
    for (const name of ["CAVERNS.COM", "HYPERDRV.COM", "HYPERD2.COM"])
      disk.add_import(name, games.read_file(name));
    bytes = Uint8Array.from(disk.export_candidate());
    assert.deepEqual(bytes.subarray(0, 16384), system.subarray(0, 16384));
    const reopened = new CpmDisk(bytes);
    try {
      for (const name of ["CAVERNS.COM", "HYPERDRV.COM", "HYPERD2.COM"])
        assert.deepEqual(reopened.read_file(name), games.read_file(name));
    } finally {
      reopened.free();
    }
  } finally {
    games.free();
    disk.free();
  }
  const sha256 = hash(bytes);
  const asset = `launch-games-${sha256}.img`;
  return {
    image: { asset, bytes },
    descriptor: {
      id: "games",
      name: "Caverns & Hyperdrive",
      instruction: "Type CAVERNS, HYPERDRV or HYPERD2",
      profile: library.bootstrap.profile,
      image: { asset, bytes: bytes.length, sha256 },
    },
    provenance: {
      sources: library.catalogue.images.filter((row) =>
        ["system-2m-n04", "games-2m"].includes(row.id),
      ),
      image: { asset, bytes: bytes.length, sha256 },
      preparation:
        "System area and game files copied unchanged from the verified library inputs; see disk-library-provenance.json.",
    },
  };
}
const GAMES = [
  ["caverns80", "CAVERNS.COM"],
  ["hyperdrive", "HYPERDRV.COM"],
  ["hyperdrive2", "HYPERD2.COM"],
];
const README = Buffer.from(
  "TRIPTYCH GAMES\r\n\r\n" +
    "At the CP/M prompt, select the games drive:\r\n" +
    "B:\r\n\r\n" +
    "Then run either game:\r\n" +
    "CAVERNS\r\n" +
    "HYPERDRV\r\n" +
    "HYPERD2\r\n\r\n" +
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

const LIBRARY_README = Buffer.from(
  "TRIPTYCH GAMES\r\n\r\n" +
    "Run CAVERNS, HYPERDRV or HYPERD2 from this disk.\r\n" +
    "All three games include their story and help.\r\n\r\n" +
    "The published disk is read-only. To save on this drive, make a\r\n" +
    "writable copy first. Games save to the current CP/M drive.\r\n" +
    "Inserting another writable disk does not redirect game saves.\r\n",
  "ascii",
);

/** Additional library media, independent of the historical public A/B starter.
 * Inputs come from this build's verified distribution and N4 system tuple.
 * Content-addressed names detect replacement; this builder makes no promise that
 * old deployment assets are retained by the hosting provider.
 */
export function buildDiskLibraryDistribution({
  distribution,
  twoMibSystem,
  componentLockBytes,
  CpmDisk,
}) {
  const { disk, manifest } = distribution;
  const { system, bootstrap, descriptor, residentLockBytes } = twoMibSystem;
  assert.equal(manifest.targetProfile, "triptych-cpu-v0.1");
  assert.equal(disk.length, 256512);
  assert.equal(disk.length, manifest.disk.bytes);
  assert.equal(
    hash(disk),
    manifest.disk.sha256,
    "library source distribution digest",
  );
  assert.equal(
    hash(componentLockBytes),
    manifest.lockSha256,
    "library component licence lock identity",
  );
  const lock = validateComponentLock(
    JSON.parse(Buffer.from(componentLockBytes).toString("utf8")),
    { recipes: new Set(["verified-release", "atom-binary", "atom-cpm22"]) },
  );
  assert.equal(descriptor.schema, "triptych-two-mib-system-v1");
  assert.equal(descriptor.id, "triptych-cpm-2m-v1");
  assert.equal(descriptor.residentProfile, "triptych-cpu-v0.1-2m-n04");
  assert.equal(descriptor.configuredCount, 4);
  assert.equal(descriptor.imageBytes, 2097152);
  assert.equal(descriptor.systemBytes, 16384);
  assert.equal(descriptor.layout.ccp, 0xe400);
  assert.equal(descriptor.system.asset, "system-triptych-cpm-2m-n04-v1.bin");
  assert.equal(
    descriptor.bootstrap.asset,
    "bootstrap-triptych-cpm-2m-n04-v1.bin",
  );
  assert.equal(system.length, 16384);
  assert.equal(
    hash(system),
    descriptor.system.sha256,
    "library N4 system identity",
  );
  assert.equal(bootstrap.length, 256);
  assert.equal(
    hash(bootstrap),
    descriptor.bootstrap.sha256,
    "library N4 bootstrap identity",
  );
  assert(
    system.subarray(6656).every((byte) => byte === 0),
    "N4 reserved system area",
  );
  assert.deepEqual(
    { revision: descriptor.machine.revision, dirty: descriptor.machine.dirty },
    manifest.triptych,
    "one build identity",
  );
  assert.equal(
    hash(residentLockBytes),
    descriptor.residents.lockSha256,
    "N4 resident licence lock identity",
  );
  const residentLock = validateComponentLock(
    JSON.parse(Buffer.from(residentLockBytes).toString("utf8")),
    { recipes: new Set(["verified-release"]) },
  );
  assert.equal(residentLock.targetProfile, descriptor.residentProfile);
  const source = new CpmDisk(disk);
  let files;
  try {
    files = source
      .file_names()
      .sort()
      .map((name) => ({ name, bytes: readCpm22File(disk, name) }));
  } finally {
    source.free();
  }
  const components = manifest.components.filter(
    (component) => component.install?.kind === "file",
  );
  const fileNames = new Set();
  const provenanceComponents = components.map((component) => {
    assert(
      !fileNames.has(component.install.name),
      "duplicate installed component",
    );
    fileNames.add(component.install.name);
    const file = files.find((file) => file.name === component.install.name);
    assert(file, `missing ${component.id} file`);
    const pinned = lock.components.filter((entry) => entry.id === component.id);
    assert.equal(pinned.length, 1);
    assert.deepEqual(component.source, pinned[0].source);
    assert.deepEqual(component.install, pinned[0].install);
    assert.deepEqual(component.target, pinned[0].target);
    if (pinned[0].artifact) {
      assert.equal(component.bytes, pinned[0].artifact.bytes);
      assert.equal(component.sha256, pinned[0].artifact.sha256);
    }
    assert.equal(file.bytes.length, Math.ceil(component.bytes / 128) * 128);
    assert.equal(
      hash(file.bytes.subarray(0, component.bytes)),
      component.sha256,
      `${component.id} released file bytes`,
    );
    assert(
      file.bytes
        .subarray(component.bytes)
        .every((byte) => byte === component.install.padByte),
      `${component.id} record padding`,
    );
    return {
      ...structuredClone(component),
      licence: structuredClone(pinned[0].licence),
      artifact: structuredClone(pinned[0].artifact ?? null),
    };
  });
  const games = GAMES.map(([id, name]) => {
    const matches = components.filter((component) => component.id === id);
    assert.equal(matches.length, 1, `one ${id} game`);
    assert.equal(matches[0].install.name, name);
    return files.find((file) => file.name === name);
  });
  for (const name of ["ATOM.COM", "NUC.COM", "EDIT.COM"])
    assert(fileNames.has(name), `${name} tool required`);
  const samples = manifest.components
    .filter(
      (component) =>
        component.source.kind === "triptych" && component.install === undefined,
    )
    .map((sample) => {
      const file = files.find((file) => file.name === sample.id);
      assert(file, `missing ${sample.id} sample`);
      assert.equal(hash(file.bytes.subarray(0, sample.bytes)), sample.sha256);
      assert.equal(file.bytes.length, Math.ceil(sample.bytes / 128) * 128);
      assert(file.bytes.subarray(sample.bytes).every((byte) => byte === 26));
      return {
        ...structuredClone(sample),
        licence: { spdx: "GPL-3.0-or-later", provenance: "NOTICE.md" },
      };
    });
  assert.equal(
    files.length,
    components.length + samples.length,
    "all copied files have provenance",
  );
  const create = (imports, systemArea) => {
    const candidate = CpmDisk.create_two_mib();
    try {
      for (const file of imports) candidate.add_import(file.name, file.bytes);
      const bytes = Uint8Array.from(candidate.export_candidate());
      assert.equal(bytes.length, 2097152);
      assert(bytes.subarray(0, 16384).every((byte) => byte === 0));
      if (systemArea) bytes.set(systemArea);
      return bytes;
    } finally {
      candidate.free();
    }
  };
  const bodies = [
    {
      id: "system-2m-n04",
      name: "Triptych tools and system (four drives)",
      files: files.filter((file) => !games.includes(file)),
      systemProfile: descriptor.residentProfile,
    },
    {
      id: "games-2m",
      name: "Caverns, Hyperdrive and Hyperdrive II",
      files: [...games, { name: "README.TXT", bytes: LIBRARY_README }],
      systemProfile: null,
    },
  ];
  const sourceUrl = `https://github.com/jhlagado/triptych/tree/${manifest.triptych.revision}`;
  const images = bodies.map((body) => {
    const bytes = create(body.files, body.systemProfile ? system : null),
      sha256 = hash(bytes);
    return {
      ...body,
      bytes,
      sha256,
      asset: `library-${body.id}-${sha256}.img`,
    };
  });
  const catalogue = validateDiskCatalogue({
    schema: "triptych-disk-catalogue-v1",
    images: images.map((image) => ({
      id: image.id,
      revision: image.sha256,
      name: image.name,
      geometry: "triptych-cpm-2m-v1",
      byteLength: image.bytes.length,
      sha256: image.sha256,
      asset: image.asset,
      source: sourceUrl,
      license:
        "Mixed GPL-3.0-only and GPL-3.0-or-later components; see disk-library-provenance.json.",
      systemProfile: image.systemProfile,
    })),
  });
  const provenance = {
    schema: "triptych-disk-library-provenance-v1",
    machine: structuredClone(manifest.triptych),
    sourceDistribution: structuredClone(manifest),
    componentLock: lock,
    residentLock,
    system: structuredClone(descriptor),
    components: provenanceComponents,
    samples,
    generatedReadme: {
      source: "tools/lib/public-drive-distribution.mjs",
      bytes: LIBRARY_README.length,
      sha256: hash(LIBRARY_README),
      licence: { spdx: "GPL-3.0-or-later", provenance: "LICENSE" },
    },
    images: images.map((image) => ({
      asset: image.asset,
      sha256: image.sha256,
      bytes: image.bytes.length,
      systemProfile: image.systemProfile,
      files: image.files.map((file) => ({
        name: file.name,
        bytes: file.bytes.length,
        sha256: hash(file.bytes),
      })),
    })),
  };
  return {
    catalogue,
    provenance,
    images: images.map(({ asset, bytes }) => ({ asset, bytes })),
    bootstrap: {
      profile: descriptor.residentProfile,
      asset: descriptor.bootstrap.asset,
      sha256: descriptor.bootstrap.sha256,
      byteLength: bootstrap.length,
    },
  };
}
