import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(import.meta.dirname, "..");
const vendor = join(root, "third_party/colossal-cave");
export const COLOSSAL_CAVE_IMAGE_SHA256 =
  "5dc331b1be3609cb72bb728d3f64b811d9aea95b8357c9cb3224d150596bad33";
export const COLOSSAL_CAVE_FILES = Object.freeze([
  Object.freeze({
    source: "Adventur.com",
    name: "ADVENTUR.COM",
    bytes: 45824,
    sha256: "10cdb0b98c9c34bf75ccbf81416afd345e9f5a03c5a829361440cd7ade34cce2",
  }),
  Object.freeze({
    source: "Phrogz.din",
    name: "PHROGZ.DIN",
    bytes: 113792,
    sha256: "1608f09301e81c3a092ce91a534828f4abede339a3ebbc30de9297c65f5b6e7f",
  }),
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Build an unchanged r1 data image using the caller's existing image binding.
 * No WASM load, output write, browser state or network access occurs at import.
 * Returns {image:Buffer, metadata:object, files:[{name,bytes:Uint8Array}]}.
 * metadata is provenance, not a parallel disk-library catalogue schema.
 */
export async function buildColossalCaveImage({
  CpmDisk,
  inputDirectory = vendor,
} = {}) {
  assert(CpmDisk, "CpmDisk binding required");
  const provenance = JSON.parse(
    await readFile(join(vendor, "manifest.json"), "utf8"),
  );
  assert.deepEqual(provenance.files, COLOSSAL_CAVE_FILES);
  assert.equal(provenance.image.sha256, COLOSSAL_CAVE_IMAGE_SHA256);
  const files = [];
  const disk = CpmDisk.create_two_mib();
  try {
    for (const file of COLOSSAL_CAVE_FILES) {
      const bytes = new Uint8Array(
        await readFile(join(inputDirectory, file.source)),
      );
      assert.equal(bytes.length, file.bytes, `${file.source} length`);
      assert.equal(hash(bytes), file.sha256, `${file.source} hash`);
      files.push({ name: file.name, bytes });
      disk.add_import(file.name, bytes);
    }
    const image = Buffer.from(disk.export_candidate());
    assert.equal(image.length, 2097152);
    assert.equal(
      hash(image),
      COLOSSAL_CAVE_IMAGE_SHA256,
      "immutable r1 image changed",
    );
    assert(image.subarray(0, 16384).every((byte) => byte === 0));
    const reopened = new CpmDisk(image);
    try {
      assert.equal(reopened.geometry_id(), "triptych-cpm-2m-v1");
      assert.deepEqual(
        reopened.file_names(),
        files.map((file) => file.name),
      );
      for (const file of files)
        assert.deepEqual(
          new Uint8Array(reopened.read_file(file.name)),
          file.bytes,
        );
    } finally {
      reopened.free();
    }
    return {
      image,
      files,
      metadata: {
        candidateId: provenance.id,
        revision: provenance.imageLabel,
        displayName: provenance.name,
        publicationStatus:
          "distribution-authorised-hosted-qualification-pending",
        source: provenance.source,
        archiveListing: provenance.archiveListing,
        foundation: provenance.foundation,
        archiveSha256: provenance.archiveSha256,
        copyright: provenance.copyright,
        license: provenance.license,
        distributionDecision: provenance.distributionDecision,
        image: {
          file: provenance.image.file,
          format: "triptych-cpm-2m-v1",
          bytes: image.length,
          sha256: hash(image),
          bootable: false,
        },
        geometry: {
          recordBytes: 128,
          recordsPerTrack: 128,
          tracks: 128,
          reservedTracks: 1,
          allocationBlockBytes: 2048,
          allocationBlocks: 1016,
          directoryEntries: 1024,
        },
        requiredProfile: provenance.testedProfile,
        intendedMount:
          "C; A contains the matching Triptych system and B is writable for core-image saves",
        launch: ["C:", "ADVENTUR"],
        saveWorkflow: provenance.saveWorkflow,
        transformations: provenance.transformations,
        files: provenance.files,
      },
    };
  } finally {
    disk.free();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  assert(
    args.length === 1 || args.length === 2,
    "Usage: node tools/build-colossal-cave-image.mjs [INPUT_DIRECTORY] OUTPUT_DIRECTORY",
  );
  const output = resolve(args.at(-1));
  const { CpmDisk } = createRequire(import.meta.url)(
    join(root, "dist/wasm/triptych_host_wasm.js"),
  );
  const { image, metadata, files } = await buildColossalCaveImage({
    CpmDisk,
    inputDirectory: args.length === 2 ? resolve(args[0]) : vendor,
  });
  await mkdir(output, { recursive: true });
  await mkdir(join(output, "files"), { recursive: true });
  for (const [name, bytes] of [
    ...files.map((file) => [join("files", file.name), Buffer.from(file.bytes)]),
    [metadata.image.file, image],
    ["candidate.json", Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`)],
  ]) {
    const path = join(output, name);
    try {
      assert.deepEqual(
        await readFile(path),
        bytes,
        `Existing output differs: ${path}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(path, bytes, { flag: "wx" });
    }
  }
  console.log(JSON.stringify(metadata.image));
}
