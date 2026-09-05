import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { installCpm22File } from "./cpm22-disk.mjs";

export const EDIT_REVISION = "2427501773e8d158d556631b8a4ba1cb972fcb4a";
export const EDIT_SHA256 =
  "73265438a4f2df9a3f507f1bdcd49c48ebabe46cbcdb96e58dc0ee39f8b6a905";
export const EDIT_BYTES = 3107;

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
  assert.equal(manifest.version, "0.1.1");
  assert.equal(manifest.assembler.name, "atom-z80");
  assert.equal(
    manifest.assembler.revision,
    "802b5c2d320bec777f427755ff2d7338e3b80a05",
  );
  assert.equal(manifest.bytes, EDIT_BYTES);
  assert.equal(manifest.sha256, EDIT_SHA256);
  assert.equal(manifest.loadAddress, 0x0100);
  assert.equal(manifest.entryAddress, 0x0100);
  assert.equal(provenance.revision, EDIT_REVISION);
  assert.equal(provenance.repository, "https://github.com/jhlagado/edit.git");
  assert.equal(provenance.bytes, EDIT_BYTES);
  assert.equal(provenance.sha256, EDIT_SHA256);

  return Uint8Array.from(bytes);
}

export async function installVerifiedEditRelease(image, repositoryRoot) {
  const bytes = await readVerifiedEditRelease(repositoryRoot);
  return installCpm22File(image, { name: "EDIT.COM", bytes, padByte: 0x1a });
}
