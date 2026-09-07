import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { installCpm22File } from "./cpm22-disk.mjs";

export const EDIT_REVISION = "dbbda081b58077c98b509625176739bd9c5608ec";
export const EDIT_SHA256 =
  "6be83f6edb9ee92387c7b3817f473fbbc389a58ab1a20d9a2a6101e695fb77c4";
export const EDIT_BYTES = 5513;

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
  assert.equal(manifest.version, "0.2.0");
  assert.equal(manifest.sourceFormat, "native-atom");
  assert.equal(manifest.releaseBaselineMatch, true);
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
