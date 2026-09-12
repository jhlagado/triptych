import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import {
  buildColossalCaveImage,
  COLOSSAL_CAVE_FILES,
} from "../build-colossal-cave-image.mjs";
import {
  appendColossalCaveLibrary as append,
  COLOSSAL_CAVE_IMAGE_SHA256 as expectedHash,
} from "./colossal-cave-library.mjs";
import { captureDiskLibraryRelease } from "./disk-library-release.mjs";
import { buildCpmDistribution } from "./cpm-distribution.mjs";
import { buildTwoMibSystem } from "./two-mib-system.mjs";
import { buildDiskLibraryDistribution } from "./public-drive-distribution.mjs";

const { CpmDisk } = createRequire(import.meta.url)(
  "../../dist/wasm/triptych_host_wasm.js",
);
const original = await buildColossalCaveImage({ CpmDisk });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const candidate = () => ({
  image: Uint8Array.from(original.image),
  metadata: structuredClone(original.metadata),
});
const library = () => ({
  bootstrap: {
    profile: "triptych-cpu-v0.1-2m-n04",
    asset: "bootstrap.bin",
    sha256: "0".repeat(64),
    byteLength: 256,
  },
  catalogue: { schema: "triptych-disk-catalogue-v1", images: [] },
  images: [],
  provenance: { schema: "triptych-disk-library-provenance-v1", images: [] },
});

test("real vendored inputs produce exact protected catalogue image and detached provenance", () => {
  const before = library(),
    input = candidate();
  const librarySnapshot = structuredClone(before),
    inputSnapshot = structuredClone(input);
  const result = append(before, input);
  assert.deepEqual(before, librarySnapshot);
  assert.deepEqual(input, inputSnapshot);
  assert.equal(result.catalogue.images.length, 1);
  const row = result.catalogue.images[0];
  assert.deepEqual(
    {
      id: row.id,
      revision: row.revision,
      geometry: row.geometry,
      byteLength: row.byteLength,
      sha256: row.sha256,
      systemProfile: row.systemProfile,
    },
    {
      id: "colossal-cave-350",
      revision: expectedHash,
      geometry: "triptych-cpm-2m-v1",
      byteLength: 2097152,
      sha256: expectedHash,
      systemProfile: null,
    },
  );
  assert.equal(row.asset, `library-colossal-cave-350-${expectedHash}.img`);
  assert.equal(
    row.source,
    "https://www.ifarchive.org/if-archive/games/cpm/Advent_CPM.zip",
  );
  assert.match(row.license, /all rights reserved/);
  assert.match(row.license, /No licence supplied/);
  assert.equal(hash(result.images[0].bytes), expectedHash);
  assert(result.images[0].bytes.subarray(0, 16384).every((byte) => byte === 0));
  const disk = new CpmDisk(result.images[0].bytes);
  try {
    assert.deepEqual(disk.file_names(), ["ADVENTUR.COM", "PHROGZ.DIN"]);
    for (const file of COLOSSAL_CAVE_FILES) {
      const bytes = disk.read_file(file.name);
      assert.equal(bytes.length, file.bytes);
      assert.equal(hash(bytes), file.sha256);
    }
  } finally {
    disk.free();
  }
  assert.deepEqual(result.provenance.images[0].preparation, input.metadata);
  assert.deepEqual(
    result.provenance.images[0].preparation.files,
    COLOSSAL_CAVE_FILES,
  );
  input.image.fill(0);
  input.metadata.files[0].sha256 = "0".repeat(64);
  assert.equal(hash(result.images[0].bytes), expectedHash);
  assert.equal(
    result.provenance.images[0].preparation.files[0].sha256,
    COLOSSAL_CAVE_FILES[0].sha256,
  );
});

test("changed bytes, profile mismatch and duplicate image IDs reject without mutation", () => {
  for (const damage of [
    "byte",
    "length",
    "system",
    "library-profile",
    "metadata-profile",
    "duplicate",
  ]) {
    const base = library(),
      input = candidate();
    if (damage === "byte") input.image[input.image.length - 1] ^= 1;
    if (damage === "length")
      input.image = input.image.subarray(0, input.image.length - 1);
    if (damage === "system") input.image[0] = 1;
    if (damage === "library-profile")
      base.bootstrap.profile = "triptych-cpu-v0.1-2m-n16";
    if (damage === "metadata-profile")
      input.metadata.requiredProfile = "legacy-e400";
    if (damage === "duplicate")
      base.catalogue.images.push({ id: "colossal-cave-350" });
    const baseline = structuredClone(base),
      captured = structuredClone(input);
    assert.throws(() => append(base, input), undefined, damage);
    assert.deepEqual(base, baseline);
    assert.deepEqual(input, captured);
  }
});

test("malformed or false preparation metadata cannot be retained as provenance", () => {
  for (const change of [
    (metadata) => {
      metadata.candidateId = "other";
    },
    (metadata) => {
      metadata.image.sha256 = "0".repeat(64);
    },
    (metadata) => {
      metadata.image.bytes = 1;
    },
    (metadata) => {
      metadata.files[0].sha256 = "0".repeat(64);
    },
    (metadata) => {
      metadata.files.pop();
    },
    (metadata) => {
      delete metadata.distributionDecision;
    },
  ]) {
    const base = library(),
      input = candidate();
    change(input.metadata);
    assert.throws(() => append(base, input), undefined, change.toString());
    assert.deepEqual(base, library());
  }
});

test("appended image is retained by current N4 release capture without changing starter slots", async () => {
  // Node qualification runs before the browser build in a clean checkout.
  // Produce the exact source tuple in memory; never consume browser artifacts.
  const root = resolve(import.meta.dirname, "../..");
  const distribution = await buildCpmDistribution(root, { allowDirty: true });
  const tuple = await buildTwoMibSystem(root, 4, { allowDirty: true });
  const profile = tuple.descriptor;
  const base = buildDiskLibraryDistribution({
    distribution,
    CpmDisk,
    componentLockBytes: await readFile(
      resolve(root, "distribution/components.lock.json"),
    ),
    twoMibSystem: {
      ...tuple,
      residentLockBytes: await readFile(resolve(root, profile.residents.lock)),
    },
  });
  const result = append(base, candidate());
  const envelope = {
    schema: "triptych-browser-deployment-v1",
    twoMibProfiles: [profile],
    assets: [profile.system, profile.bootstrap].map(
      ({ asset, bytes, sha256 }) => ({ path: asset, bytes, sha256 }),
    ),
  };
  const assets = new Map(
    result.images.map(({ asset, bytes }) => [asset, bytes]),
  );
  assets.set(profile.system.asset, tuple.system);
  assets.set(profile.bootstrap.asset, tuple.bootstrap);
  const blank = CpmDisk.create_two_mib();
  try {
    const captured = captureDiskLibraryRelease({
      catalogueBytes: Buffer.from(JSON.stringify(result.catalogue)),
      provenanceBytes: Buffer.from(JSON.stringify(result.provenance)),
      admissionBytes: Buffer.from(JSON.stringify(envelope)),
      assets,
      blankSeed: blank.export_source(),
    });
    const row = captured.manifest.images.find(
      (row) => row.id === "colossal-cave-350",
    );
    assert.equal(hash(captured.assets.get(row.asset)), expectedHash);
    for (const id of ["starter", "library"]) {
      const recipe = captured.manifest.recipes.find((row) => row.id === id);
      assert.equal(recipe.slots[0].image.id, "system-2m-n04");
      assert.equal(recipe.slots[2].image.id, "games-2m");
    }
    const adventure = captured.manifest.recipes.find(
      (row) => row.id === "colossal-cave-350",
    );
    assert.equal(adventure.configuredCount, 4);
    assert.equal(adventure.slots[0].image.id, "system-2m-n04");
    assert.equal(adventure.slots[1].role, "work");
    assert.equal(adventure.slots[2].image.id, "colossal-cave-350");
    assert.equal(adventure.slots[3], null);
  } finally {
    blank.free();
  }
});
