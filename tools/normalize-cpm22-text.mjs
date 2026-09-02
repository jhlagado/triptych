import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const imagePath = join(repositoryRoot, "third_party", "cpm22", "cpm22.img");
const temporaryPath = `${imagePath}.normalize-${process.pid}.tmp`;
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function logicalText(physical, name) {
  const end = physical.indexOf(0x1a);
  const logical = end === -1 ? physical : physical.subarray(0, end);
  assert.ok(
    [...logical].every((byte) => byte <= 0x7f),
    `${name} contains non-ASCII text`,
  );
  return Buffer.from(logical).toString("ascii");
}

let image = new Uint8Array(await readFile(imagePath));
const before = sha256(image);
const changed = [];
for (const name of textFiles) {
  const source = logicalText(readCpm22File(image, name), name);
  const normalized = source.replace(/\r\n|\r|\n/gu, "\r\n");
  if (normalized === source) continue;
  image = installCpm22File(image, {
    name,
    bytes: Uint8Array.from(Buffer.from(normalized, "ascii")),
  });
  changed.push(name);
}

try {
  if (changed.length > 0) {
    await writeFile(temporaryPath, image, { flag: "wx" });
    await rename(temporaryPath, imagePath);
  }
} catch (error) {
  await rm(temporaryPath, { force: true });
  throw error;
}

console.log(
  JSON.stringify(
    {
      status: changed.length > 0 ? "normalized" : "unchanged",
      image: "third_party/cpm22/cpm22.img",
      changed,
      beforeSha256: before,
      afterSha256: sha256(image),
    },
    undefined,
    2,
  ),
);
