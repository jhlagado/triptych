import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";

// Investigation recipe, not a published library catalogue entry. The upstream
// binary's redistribution permission remains unresolved.
const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { CpmDisk } = require(join(root, "dist/wasm/triptych_host_wasm.js"));
const [input, output] = process.argv.slice(2);
assert.ok(
  input && output,
  "Usage: node tools/build-colossal-cave-image.mjs INPUT_DIRECTORY OUTPUT_DIRECTORY",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [
  {
    source: "Adventur.com",
    name: "ADVENTUR.COM",
    bytes: 45824,
    sha256: "10cdb0b98c9c34bf75ccbf81416afd345e9f5a03c5a829361440cd7ade34cce2",
  },
  {
    source: "Phrogz.din",
    name: "PHROGZ.DIN",
    bytes: 113792,
    sha256: "1608f09301e81c3a092ce91a534828f4abede339a3ebbc30de9297c65f5b6e7f",
  },
];
const disk = CpmDisk.create_two_mib();
try {
  const originals = [];
  for (const file of files) {
    const bytes = await readFile(join(input, file.source));
    assert.equal(bytes.length, file.bytes);
    assert.equal(hash(bytes), file.sha256, file.source);
    originals.push(bytes);
    disk.add_import(file.name, bytes);
  }
  const image = Buffer.from(disk.export_candidate());
  assert.equal(image.length, 2097152);
  assert.ok(image.subarray(0, 16384).every((byte) => byte === 0));
  const reopened = new CpmDisk(image);
  try {
    assert.deepEqual(
      reopened.file_names(),
      files.map((file) => file.name),
    );
    for (let i = 0; i < files.length; i++) {
      assert.deepEqual(
        Buffer.from(reopened.read_file(files[i].name)),
        originals[i],
      );
    }
  } finally {
    reopened.free();
  }
  const metadata = {
    candidateId: "colossal-cave-350",
    revision: "r1",
    displayName: "Colossal Cave Adventure (350 points)",
    description: "Text adventure for CP/M and Z80; investigation candidate.",
    publicationStatus: "blocked-pending-redistribution-permission",
    source: "https://www.ifarchive.org/if-archive/games/cpm/Advent_CPM.zip",
    archiveSha256:
      "9a9feb501c15c728f1e4e88eda6de325f1270052a205c6f27dc86f3c8d4d492a",
    upstreamVersion:
      "Archive dated 2025-10-31; executable version not established",
    permission:
      "Executable contains copyright 1977 Small System Services, Inc.; all rights reserved. Archive includes no licence.",
    image: {
      file: "colossal-cave-350-r1.img",
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
    requiredProfile: "triptych-cpu-v0.1-2m-n04",
    intendedMount: "C; A must contain the matching Triptych system",
    launch: ["C:", "ADVENTUR"],
    storage:
      "Read-only policy belongs to the sector provider. Saving requires a separately qualified core-image workflow; see qualification report.",
    transformations:
      "Uppercase 8.3 names only. No byte changes, text conversion or padding: both input lengths are already multiples of 128.",
    files,
  };
  await mkdir(output, { recursive: true });
  await mkdir(join(output, "files"), { recursive: true });
  // A revision must never silently acquire different bytes.
  for (const [name, bytes] of [
    ...files.map((file, i) => [join("files", file.name), originals[i]]),
    [metadata.image.file, image],
    ["candidate.json", Buffer.from(JSON.stringify(metadata, null, 2) + "\n")],
  ]) {
    const path = join(output, name);
    try {
      assert.deepEqual(
        await readFile(path),
        bytes,
        `Existing revision differs: ${path}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(path, bytes, { flag: "wx" });
    }
  }
  console.log(JSON.stringify(metadata.image));
} finally {
  disk.free();
}
