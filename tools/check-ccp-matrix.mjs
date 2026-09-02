import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assembleTriptychCpuFirmware } from "./cpm22-native-image.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const matrixPath = resolve(
  repositoryRoot,
  "test/ccp/fixtures/feature-matrix.json",
);
const matrix = JSON.parse(await readFile(matrixPath, "utf8"));

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

assert.equal(matrix.schema, "triptych-ccp-feature-matrix-v1");
assert.equal(typeof matrix.publicationReady, "boolean");

const oracleImage = await readFile(resolve(repositoryRoot, matrix.oracle.path));
const oracle = oracleImage.subarray(
  matrix.oracle.offset,
  matrix.oracle.offset + matrix.oracle.bytes,
);
assert.equal(oracle.length, 0x0800, "oracle CCP resident bytes");
assert.equal(sha256(oracle), matrix.oracle.sha256, "oracle CCP SHA-256");

const { ccp } = await assembleTriptychCpuFirmware(repositoryRoot);
assert.equal(matrix.target.loadAddress, 0xe400, "Triptych CCP load address");
assert.equal(ccp.length, matrix.target.bytes, "Triptych CCP resident bytes");
assert.equal(sha256(ccp), matrix.target.sha256, "Triptych CCP SHA-256");

assert.ok(Array.isArray(matrix.features) && matrix.features.length > 0);
const featureIds = new Set();
for (const feature of matrix.features) {
  assert.match(feature.id, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(featureIds.has(feature.id), false, `duplicate ${feature.id}`);
  featureIds.add(feature.id);
  assert.ok(
    feature.status === "planned" ||
      feature.status === "partial" ||
      feature.status === "proved",
    `${feature.id} status`,
  );
  assert.ok(Array.isArray(feature.evidence), `${feature.id} evidence`);
  if (feature.status === "proved") {
    assert.ok(feature.evidence.length > 0, `${feature.id} has evidence`);
  }
  for (const evidence of feature.evidence) {
    await access(resolve(repositoryRoot, evidence));
  }
}

for (const required of [
  "boot-prompt",
  "case-and-command-tail",
  "default-fcbs",
  "transient-load-and-return",
  "dir",
  "type",
  "era",
  "ren",
  "save",
  "user",
  "resident-stack-and-size",
  "bundled-applications",
  "native-wasm-equivalence",
  "published-system",
  "esp32-hardware",
]) {
  assert.ok(featureIds.has(required), `missing CCP feature ${required}`);
}

if (matrix.publicationReady) {
  assert.ok(
    matrix.features.every((feature) => feature.status === "proved"),
    "a publishable CCP cannot retain planned feature rows",
  );
}

console.log(
  `CCP matrix checks passed (${matrix.features.filter((feature) => feature.status === "proved").length}/${matrix.features.length} features proved)`,
);
