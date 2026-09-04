import assert from "node:assert/strict";

// v2: publicationReady covers software; hardwareQualified additionally covers
// physical ESP32 evidence. Structural/evidence validation stays in the caller.
export function assertCcpReadiness(matrix) {
  assert.equal(typeof matrix.publicationReady, "boolean");
  assert.equal(typeof matrix.hardwareQualified, "boolean");
  const hardware = matrix.features.find(
    (feature) => feature.id === "esp32-hardware",
  );
  const software = matrix.features.filter(
    (feature) => feature.id !== "esp32-hardware",
  );
  assert.ok(
    hardware,
    "hardware qualification must retain an explicit feature row",
  );
  assert.ok(
    software.length > 0,
    "software readiness requires software feature rows",
  );

  if (matrix.publicationReady || matrix.hardwareQualified) {
    assert.ok(
      software.every((feature) => feature.status === "proved"),
      "a qualified CCP cannot retain incomplete software feature rows",
    );
  }
  if (matrix.hardwareQualified) {
    assert.ok(
      hardware.status === "proved",
      "hardware qualification requires physical ESP32 proof",
    );
  }
}
