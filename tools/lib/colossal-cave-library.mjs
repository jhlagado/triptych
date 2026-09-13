import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { COLOSSAL_CAVE_FILES } from "../build-colossal-cave-image.mjs";
import { validateDiskCatalogue } from "../../crates/triptych-host-wasm/web/disk-catalogue.js";

export const COLOSSAL_CAVE_IMAGE_SHA256 =
  "5dc331b1be3609cb72bb728d3f64b811d9aea95b8357c9cb3224d150596bad33";
const DIRECT_EXECUTABLE = "ADVENT.COM";
const ORIGINAL_EXECUTABLE = "ADVENTUR.COM";

// Extend the existing catalogue and provenance together. This data disk does
// not supply residents and does not change the starter's mounted games disk.
export function appendColossalCaveLibrary(library, { image, metadata }) {
  assert.equal(library.bootstrap.profile, "triptych-cpu-v0.1-2m-n04");
  assert(image instanceof Uint8Array);
  const bytes = Uint8Array.from(image);
  assert.equal(bytes.length, 2097152);
  assert(bytes.subarray(0, 16384).every((byte) => byte === 0));
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    COLOSSAL_CAVE_IMAGE_SHA256,
  );
  assert.equal(metadata.candidateId, "colossal-cave-350");
  assert.equal(metadata.image.sha256, COLOSSAL_CAVE_IMAGE_SHA256);
  assert.equal(metadata.image.bytes, bytes.length);
  assert.equal(metadata.image.format, "triptych-cpm-2m-v1");
  assert.equal(metadata.image.bootable, false);
  assert.deepEqual(metadata.files, COLOSSAL_CAVE_FILES);
  assert.equal(metadata.distributionDecision?.authorisedBy, "John Hardy");
  assert.equal(metadata.distributionDecision?.date, "2026-09-12");
  assert.equal(metadata.distributionDecision?.rightsInvestigation, "deferred");
  assert.equal(
    metadata.distributionDecision?.iftfRightsIndependentlyVerified,
    false,
  );
  assert.equal(metadata.requiredProfile, library.bootstrap.profile);
  const id = "colossal-cave-350";
  assert(!library.catalogue.images.some((row) => row.id === id));
  const asset = `library-${id}-${COLOSSAL_CAVE_IMAGE_SHA256}.img`;
  const row = {
    id,
    revision: COLOSSAL_CAVE_IMAGE_SHA256,
    name: "Colossal Cave Adventure (350 points; four-drive profile)",
    geometry: "triptych-cpm-2m-v1",
    byteLength: bytes.length,
    sha256: COLOSSAL_CAVE_IMAGE_SHA256,
    asset,
    source: "https://www.ifarchive.org/if-archive/games/cpm/Advent_CPM.zip",
    license:
      "Copyright 1977 Small System Services, Inc.; all rights reserved. No licence supplied. Distribution proceeds by project-owner decision; see retained provenance for the unresolved rights investigation.",
    systemProfile: null,
  };
  return {
    ...library,
    catalogue: validateDiskCatalogue({
      ...library.catalogue,
      images: [...library.catalogue.images, row],
    }),
    images: [...library.images, { asset, bytes }],
    provenance: {
      ...library.provenance,
      images: [
        ...library.provenance.images,
        {
          asset,
          sha256: row.sha256,
          bytes: bytes.length,
          systemProfile: null,
          preparation: structuredClone(metadata),
        },
      ],
    },
  };
}

/** Build a separate, bootable demonstration disk without changing the
 * immutable data-only Colossal Cave image. The historical executable is
 * installed under the conventional CP/M name ADVENT.COM; its bytes are not
 * modified.
 */
export function buildColossalCaveDirectLaunch({ library, cave, CpmDisk }) {
  assert.equal(library.bootstrap.profile, "triptych-cpu-v0.1-2m-n04");
  assert.equal(cave.metadata.candidateId, "colossal-cave-350");
  assert.deepEqual(cave.metadata.files, COLOSSAL_CAVE_FILES);
  assert.equal(
    createHash("sha256").update(cave.image).digest("hex"),
    COLOSSAL_CAVE_IMAGE_SHA256,
    "immutable source image",
  );
  const catalogueRow = library.catalogue.images.find(
    (row) => row.id === "system-2m-n04",
  );
  assert(catalogueRow, "N4 system image metadata");
  assert.equal(catalogueRow.systemProfile, library.bootstrap.profile);
  const source = library.images.find(
    (image) => image.asset === catalogueRow.asset,
  );
  assert(source, "N4 system image bytes");
  assert.equal(source.bytes.length, 2097152);
  assert.equal(
    createHash("sha256").update(source.bytes).digest("hex"),
    catalogueRow.sha256,
    "N4 system image identity",
  );
  const advent = cave.files.find((file) => file.name === ORIGINAL_EXECUTABLE);
  const data = cave.files.find((file) => file.name === "PHROGZ.DIN");
  assert(advent && data, "Colossal Cave program and data files");
  const disk = new CpmDisk(source.bytes);
  let bytes;
  try {
    assert(!disk.file_names().includes(DIRECT_EXECUTABLE));
    assert(!disk.file_names().includes(ORIGINAL_EXECUTABLE));
    disk.add_import(DIRECT_EXECUTABLE, advent.bytes);
    disk.add_import(data.name, data.bytes);
    bytes = Uint8Array.from(disk.export_candidate());
  } finally {
    disk.free();
  }
  assert.equal(bytes.length, 2097152);
  assert.deepEqual(bytes.subarray(0, 16384), source.bytes.subarray(0, 16384));
  const reopened = new CpmDisk(bytes);
  try {
    const names = reopened.file_names();
    assert(names.includes(DIRECT_EXECUTABLE));
    assert(names.includes("PHROGZ.DIN"));
    assert(!names.includes(ORIGINAL_EXECUTABLE));
    assert.deepEqual(
      new Uint8Array(reopened.read_file(DIRECT_EXECUTABLE)),
      advent.bytes,
    );
    assert.deepEqual(new Uint8Array(reopened.read_file(data.name)), data.bytes);
  } finally {
    reopened.free();
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const asset = `launch-advent-${sha256}.img`;
  return {
    image: { asset, bytes },
    descriptor: {
      schema: "triptych-direct-launches-v1",
      launches: [
        {
          id: "advent",
          name: "Colossal Cave Adventure",
          instruction: "Type ADVENT",
          profile: library.bootstrap.profile,
          image: { asset, bytes: bytes.length, sha256 },
        },
      ],
    },
    provenance: {
      schema: "triptych-direct-launch-provenance-v1",
      launch: "advent",
      baseImage: {
        id: catalogueRow.id,
        revision: catalogueRow.revision,
        asset: catalogueRow.asset,
        sha256: catalogueRow.sha256,
      },
      sourceImage: {
        id: cave.metadata.candidateId,
        sha256: COLOSSAL_CAVE_IMAGE_SHA256,
        source: cave.metadata.source,
        license: cave.metadata.license,
        distributionDecision: structuredClone(
          cave.metadata.distributionDecision,
        ),
      },
      files: [
        {
          source: "Adventur.com",
          installedAs: DIRECT_EXECUTABLE,
          bytes: advent.bytes.length,
          sha256: createHash("sha256").update(advent.bytes).digest("hex"),
        },
        {
          source: "Phrogz.din",
          installedAs: data.name,
          bytes: data.bytes.length,
          sha256: createHash("sha256").update(data.bytes).digest("hex"),
        },
      ],
      image: { asset, bytes: bytes.length, sha256 },
    },
  };
}
