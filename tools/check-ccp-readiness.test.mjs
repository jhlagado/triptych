import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { assertCcpReadiness } from "./lib/ccp-readiness.mjs";

const baseline = JSON.parse(
  await readFile(
    new URL("../test/ccp/fixtures/feature-matrix.json", import.meta.url),
  ),
);

function softwareReady() {
  const matrix = structuredClone(baseline);
  matrix.publicationReady = true;
  matrix.hardwareQualified = false;
  for (const feature of matrix.features) {
    feature.status = feature.id === "esp32-hardware" ? "planned" : "proved";
  }
  return matrix;
}

test("software publication does not require an ESP32 board", () => {
  assert.doesNotThrow(() => assertCcpReadiness(softwareReady()));
});

test("every incomplete software row still prevents software publication", () => {
  for (const feature of baseline.features.filter(
    (row) => row.id !== "esp32-hardware",
  )) {
    for (const status of ["planned", "partial"]) {
      const matrix = softwareReady();
      matrix.features.find((row) => row.id === feature.id).status = status;
      assert.throws(() => assertCcpReadiness(matrix));
    }
  }
});

test("hardware qualification requires hardware proof", () => {
  const matrix = softwareReady();
  matrix.publicationReady = false;
  matrix.hardwareQualified = true;
  assert.throws(() => assertCcpReadiness(matrix));
});

test("proved hardware cannot compensate for incomplete software", () => {
  const matrix = softwareReady();
  matrix.publicationReady = false;
  matrix.hardwareQualified = true;
  matrix.features.find((row) => row.id === "esp32-hardware").status = "proved";
  matrix.features.find(
    (row) => row.id === "parser-boundaries-and-fuzz",
  ).status = "partial";
  assert.throws(() => assertCcpReadiness(matrix));
});

test("full qualification and an explicitly unready baseline are valid", () => {
  const matrix = softwareReady();
  matrix.hardwareQualified = true;
  matrix.features.find((row) => row.id === "esp32-hardware").status = "proved";
  assert.doesNotThrow(() => assertCcpReadiness(matrix));
  assert.doesNotThrow(() => assertCcpReadiness(baseline));
});

test("missing or non-boolean readiness declarations are rejected", () => {
  for (const key of ["publicationReady", "hardwareQualified"]) {
    for (const value of [undefined, "false", 0, null]) {
      assert.throws(() =>
        assertCcpReadiness({ ...softwareReady(), [key]: value }),
      );
    }
  }
});

test("removing the hardware row cannot erase pending qualification", () => {
  const matrix = softwareReady();
  matrix.features = matrix.features.filter(
    (feature) => feature.id !== "esp32-hardware",
  );
  assert.throws(() => assertCcpReadiness(matrix));
});
