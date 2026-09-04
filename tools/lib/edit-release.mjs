import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { installCpm22File } from "./cpm22-disk.mjs";

export const EDIT_REVISION = "ac59b478b686b7cd1a3a340064e82d64fdc58589";
export const EDIT_SHA256 =
  "bbe4ac2b6236d178089fcd01822d0d7fa3c6159f0d2da3655eba1212dda5aa02";
export const EDIT_BYTES = 3003;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readVerifiedEditRelease(repositoryRoot) {
  const directory = join(repositoryRoot, "third_party", "edit");
  const [bytes, manifestText, provenanceText] = await Promise.all([
    readFile(join(directory, "EDIT.COM")),
    readFile(join(directory, "manifest.json"), "utf8"),
    readFile(join(directory, "PROVENANCE.json"), "utf8"),
  ]);
  const manifest = JSON.parse(manifestText);
  const provenance = JSON.parse(provenanceText);

  assert.equal(bytes.length, EDIT_BYTES, "Edit release size");
  assert.equal(sha256(bytes), EDIT_SHA256, "Edit release digest");
  assert.equal(manifest.format, "edit-build-manifest-v1");
  assert.equal(manifest.artifact, "EDIT.COM");
  assert.equal(manifest.bytes, EDIT_BYTES);
  assert.equal(manifest.sha256, EDIT_SHA256);
  assert.equal(manifest.loadAddress, 0x0100);
  assert.equal(manifest.entryAddress, 0x0100);
  assert.equal(provenance.revision, EDIT_REVISION);
  assert.equal(provenance.bytes, EDIT_BYTES);
  assert.equal(provenance.sha256, EDIT_SHA256);

  return Uint8Array.from(bytes);
}

export async function installVerifiedEditRelease(image, repositoryRoot) {
  const bytes = await readVerifiedEditRelease(repositoryRoot);
  return installCpm22File(image, { name: "EDIT.COM", bytes, padByte: 0x1a });
}
