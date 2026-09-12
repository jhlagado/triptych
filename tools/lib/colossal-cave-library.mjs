import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { COLOSSAL_CAVE_FILES } from "../build-colossal-cave-image.mjs";
import { validateDiskCatalogue } from "../../crates/triptych-host-wasm/web/disk-catalogue.js";

export const COLOSSAL_CAVE_IMAGE_SHA256 =
  "5dc331b1be3609cb72bb728d3f64b811d9aea95b8357c9cb3224d150596bad33";

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
