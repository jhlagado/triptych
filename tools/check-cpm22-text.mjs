import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { readCpm22File } from "./lib/cpm22-disk.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const imagePath = join(repositoryRoot, "third_party", "cpm22", "cpm22.img");
const textFiles = [
  "README.TXT",
  "INPUT.ASM",
  "HELLO.ASM",
  "LARGE.ASM",
  "PART1.ASM",
  "PART2.ASM",
  "BUILD.ASM",
  "INPUT.NU",
];

const image = new Uint8Array(await readFile(imagePath));
for (const name of textFiles) {
  const physical = readCpm22File(image, name);
  const end = physical.indexOf(0x1a);
  const logical = end === -1 ? physical : physical.subarray(0, end);
  const padding =
    end === -1 ? physical.subarray(physical.length) : physical.subarray(end);
  assert.ok(
    [...padding].every((byte) => byte === 0x1a),
    `${name} has non-EOF data after its first CP/M text EOF byte`,
  );
  assert.ok(
    [...logical].every((byte) => byte <= 0x7f),
    `${name} contains non-ASCII text`,
  );
  for (let offset = 0; offset < logical.length; offset += 1) {
    if (logical[offset] === 0x0a) {
      assert.equal(
        logical[offset - 1],
        0x0d,
        `${name} byte ${offset} has LF without a preceding CR`,
      );
    }
    if (logical[offset] === 0x0d) {
      assert.equal(
        logical[offset + 1],
        0x0a,
        `${name} byte ${offset} has CR without a following LF`,
      );
    }
  }
}

console.log(`Bundled CP/M text checks passed (${textFiles.length} files)`);
