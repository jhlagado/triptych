import assert from "node:assert/strict";

const REPOSITORY = "https://github.com/jhlagado/";
const OS = {
  ccp: {
    origin: 0xe400,
    entry: 0xe400,
    bytes: 2048,
    firstRecord: 0,
    recordCount: 16,
  },
  bdos: {
    origin: 0xec00,
    entry: 0xec06,
    bytes: 3584,
    firstRecord: 16,
    recordCount: 28,
  },
};
const APPLICATIONS = {
  nucleus: {
    format: "nucleus-cpm22-artifact-v1",
    file: "NUC.COM",
    source: "asm/vertical-slice/cpm22-native-compiler.asm",
  },
  edit: {
    format: "edit-build-manifest-v1",
    file: "EDIT.COM",
    source: "src/editor.asm",
  },
};

/**
 * Check target-specific semantics after structural lock and release-byte
 * verification. This reads no files and performs no installation. Application
 * capacity bounds the binary in the TPA; it does not describe runtime workspace.
 */
export function validateDistributionManifest(
  component,
  manifest,
  atomRevision,
) {
  assert.equal(
    component.recipe,
    "verified-release",
    "distribution release recipe",
  );
  assert.equal(component.source.kind, "git", "distribution source kind");
  assert.match(
    atomRevision,
    /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/,
    "ATOM revision",
  );
  assert.ok(
    manifest !== null &&
      typeof manifest === "object" &&
      !Array.isArray(manifest),
    "distribution manifest must be an object",
  );

  if (Object.hasOwn(OS, component.id)) {
    const expected = OS[component.id];
    const source = `src/${component.id}.asm`;
    assert.equal(
      component.source.repository,
      `${REPOSITORY}portable-cpm.git`,
      "OS repository",
    );
    assert.equal(component.source.path, source, "OS locked source");
    assert.equal(component.role, "resident", "OS role");
    assert.deepEqual(
      component.target,
      { origin: expected.origin, capacity: expected.bytes },
      "OS target",
    );
    assert.deepEqual(
      component.install,
      {
        kind: "system-records",
        firstRecord: expected.firstRecord,
        recordCount: expected.recordCount,
      },
      "OS installation",
    );
    assert.equal(component.artifact.bytes, expected.bytes, "OS locked bytes");
    assert.equal(
      manifest.schema,
      "portable-cpm-artifacts-v1",
      "OS manifest schema",
    );
    assert.equal(
      manifest.targetProfile,
      "triptych-cpu-v0.1",
      "OS target profile",
    );
    assert.equal(
      manifest.atom.repository,
      `${REPOSITORY}atom`,
      "OS assembler repository",
    );
    assert.equal(manifest.atom.revision, atomRevision, "OS assembler revision");
    assert.ok(Array.isArray(manifest.components), "OS manifest components");
    const ids = new Set();
    for (const entry of manifest.components) {
      assert.ok(
        entry !== null && typeof entry === "object" && !Array.isArray(entry),
        "OS component entry",
      );
      assert.equal(typeof entry.id, "string", "OS component id");
      assert.ok(!ids.has(entry.id), "duplicate OS manifest component id");
      ids.add(entry.id);
    }
    const entry = manifest.components.find(({ id }) => id === component.id);
    assert.ok(entry, "missing OS manifest component");
    assert.equal(entry.source, source, "OS manifest source");
    assert.equal(entry.file, `${component.id}.bin`, "OS manifest filename");
    assert.equal(entry.origin, expected.origin, "OS manifest origin");
    assert.equal(entry.entry, expected.entry, "OS manifest entry");
    assert.equal(entry.capacity, expected.bytes, "OS manifest capacity");
    assert.equal(entry.bytes, component.artifact.bytes, "OS manifest bytes");
    assert.equal(
      entry.sha256,
      component.artifact.sha256,
      "OS manifest SHA-256",
    );
  } else {
    assert.ok(
      Object.hasOwn(APPLICATIONS, component.id),
      "unsupported distribution component",
    );
    const expected = APPLICATIONS[component.id];
    assert.equal(
      component.source.repository,
      `${REPOSITORY}${component.id}.git`,
      "application repository",
    );
    assert.equal(
      component.source.path,
      expected.source,
      "application locked source",
    );
    assert.equal(component.role, "application", "application role");
    assert.equal(component.target.origin, 0x0100, "application target origin");
    assert.ok(
      Number.isSafeInteger(component.target.capacity) &&
        component.target.capacity > 0 &&
        component.target.capacity <= 0xe300,
      "application capacity must fit the TPA",
    );
    assert.ok(
      component.artifact.bytes <= component.target.capacity,
      "application artifact exceeds capacity",
    );
    assert.deepEqual(
      component.install,
      { kind: "file", name: expected.file, padByte: 0x1a },
      "application installation",
    );
    assert.equal(
      manifest.format,
      expected.format,
      "application manifest format",
    );
    assert.equal(
      manifest.artifact,
      expected.file,
      "application manifest filename",
    );
    assert.equal(manifest.loadAddress, 0x0100, "application load address");
    assert.equal(manifest.entryAddress, 0x0100, "application entry address");
    assert.equal(
      manifest.bytes,
      component.artifact.bytes,
      "application manifest bytes",
    );
    assert.equal(
      manifest.sha256,
      component.artifact.sha256,
      "application manifest SHA-256",
    );
    assert.equal(
      manifest.assembler.name,
      "atom-z80",
      "application assembler name",
    );
    assert.equal(
      manifest.assembler.revision,
      atomRevision,
      "application assembler revision",
    );
    if (component.id === "nucleus") {
      assert.equal(
        manifest.source,
        component.source.path,
        "Nucleus manifest source",
      );
      assert.equal(
        manifest.endAddress,
        manifest.loadAddress + manifest.bytes,
        "Nucleus end address",
      );
    }
  }
  return manifest;
}
