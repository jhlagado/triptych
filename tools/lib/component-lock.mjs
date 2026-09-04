import assert from "node:assert/strict";

export const COMPONENT_LOCK_SCHEMA = "triptych-component-lock-v1";

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PROFILE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CPM_FILENAME =
  /^[A-Z0-9][A-Z0-9_$#@!%&'()^~{}-]{0,7}(?:\.[A-Z0-9_$#@!%&'()^~{}-]{1,3})?$/;

function object(value, label) {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
  return value;
}

function exactKeys(value, required, optional, label) {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    assert.ok(allowed.has(key), `${label} has unknown field ${key}`);
  }
  for (const key of required) {
    assert.ok(Object.hasOwn(value, key), `${label} is missing ${key}`);
  }
}

function text(value, label) {
  assert.equal(typeof value, "string", `${label} must be text`);
  assert.ok(value.length > 0, `${label} must not be empty`);
}

function uint(value, label) {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0,
    `${label} must be a non-negative safe integer`,
  );
}

function relativePath(value, label) {
  text(value, label);
  assert.ok(!value.startsWith("/"), `${label} must be relative`);
  assert.ok(!value.includes("\\"), `${label} must use forward slashes`);
  assert.ok(
    !value
      .split("/")
      .some((part) => part === "" || part === "." || part === ".."),
    `${label} must be a normalized relative path`,
  );
}

function validateSource(source, label) {
  object(source, label);
  if (source.kind === "git") {
    exactKeys(source, ["kind", "repository", "revision", "path"], [], label);
    text(source.repository, `${label}.repository`);
    assert.match(source.repository, /^https:\/\//, `${label}.repository`);
    assert.match(source.revision, REVISION, `${label}.revision`);
    relativePath(source.path, `${label}.path`);
    return;
  }
  if (source.kind === "triptych") {
    exactKeys(source, ["kind", "path"], [], label);
    relativePath(source.path, `${label}.path`);
    return;
  }
  if (source.kind === "prebuilt") {
    exactKeys(
      source,
      ["kind", "path", "bytes", "sha256", "provenance"],
      [],
      label,
    );
    relativePath(source.path, `${label}.path`);
    uint(source.bytes, `${label}.bytes`);
    assert.ok(source.bytes > 0, `${label}.bytes must be positive`);
    assert.match(source.sha256, SHA256, `${label}.sha256`);
    relativePath(source.provenance, `${label}.provenance`);
    return;
  }
  assert.fail(`${label}.kind must be git, triptych, or prebuilt`);
}

function validateTarget(target, label) {
  object(target, label);
  exactKeys(target, ["origin", "capacity"], [], label);
  uint(target.origin, `${label}.origin`);
  uint(target.capacity, `${label}.capacity`);
  assert.ok(target.capacity > 0, `${label}.capacity must be positive`);
  assert.ok(
    target.origin + target.capacity <= 0x10000,
    `${label} exceeds the Z80 address space`,
  );
}

function validateInstall(install, label) {
  object(install, label);
  if (install.kind === "system-records") {
    exactKeys(install, ["kind", "firstRecord", "recordCount"], [], label);
    uint(install.firstRecord, `${label}.firstRecord`);
    uint(install.recordCount, `${label}.recordCount`);
    assert.ok(install.recordCount > 0, `${label}.recordCount must be positive`);
    return;
  }
  if (install.kind === "file") {
    exactKeys(install, ["kind", "name", "padByte"], [], label);
    assert.match(install.name, CPM_FILENAME, `${label}.name`);
    uint(install.padByte, `${label}.padByte`);
    assert.ok(install.padByte <= 0xff, `${label}.padByte must be a byte`);
    return;
  }
  assert.fail(`${label}.kind must be system-records or file`);
}

function validateLicence(licence, label) {
  object(licence, label);
  exactKeys(licence, ["spdx", "provenance"], [], label);
  text(licence.spdx, `${label}.spdx`);
  relativePath(licence.provenance, `${label}.provenance`);
}

export function validateComponentLock(value, { recipes } = {}) {
  assert.ok(
    recipes instanceof Set,
    "component lock validation requires a trusted recipe registry",
  );
  const lock = object(value, "component lock");
  exactKeys(
    lock,
    ["schema", "targetProfile", "disk", "atom", "components"],
    [],
    "component lock",
  );
  assert.equal(lock.schema, COMPONENT_LOCK_SCHEMA, "component lock schema");
  assert.match(lock.targetProfile, PROFILE, "component lock targetProfile");

  const disk = object(lock.disk, "component lock disk");
  exactKeys(
    disk,
    ["bytes", "recordBytes", "systemRecords"],
    [],
    "component lock disk",
  );
  uint(disk.bytes, "component lock disk.bytes");
  uint(disk.recordBytes, "component lock disk.recordBytes");
  uint(disk.systemRecords, "component lock disk.systemRecords");
  assert.ok(disk.bytes > 0, "component lock disk.bytes must be positive");
  assert.equal(
    disk.recordBytes,
    128,
    "component lock disk.recordBytes must match the CPU profile",
  );
  assert.ok(
    disk.bytes % disk.recordBytes === 0,
    "component lock disk.bytes must contain complete records",
  );
  assert.ok(
    disk.systemRecords * disk.recordBytes <= disk.bytes,
    "component lock disk.systemRecords exceeds the image",
  );

  const atom = object(lock.atom, "component lock atom");
  exactKeys(
    atom,
    ["repository", "revision", "package", "seed"],
    [],
    "component lock atom",
  );
  text(atom.repository, "component lock atom.repository");
  assert.match(
    atom.repository,
    /^https:\/\//,
    "component lock atom.repository",
  );
  assert.match(atom.revision, REVISION, "component lock atom.revision");
  assert.equal(atom.package, "atom-z80", "component lock atom.package");
  const seed = object(atom.seed, "component lock atom.seed");
  exactKeys(seed, ["bytes", "sha256"], [], "component lock atom.seed");
  uint(seed.bytes, "component lock atom.seed.bytes");
  assert.ok(seed.bytes > 0, "component lock atom.seed.bytes must be positive");
  assert.match(seed.sha256, SHA256, "component lock atom.seed.sha256");

  assert.ok(
    Array.isArray(lock.components),
    "component lock components must be an array",
  );
  assert.ok(
    lock.components.length > 0,
    "component lock components must not be empty",
  );
  const ids = new Set();
  const filenames = new Set();
  const systemRanges = [];
  const residentRanges = [];
  for (const [index, componentValue] of lock.components.entries()) {
    const label = `component lock components[${index}]`;
    const component = object(componentValue, label);
    exactKeys(
      component,
      ["id", "role", "source", "recipe", "target", "install", "licence"],
      [],
      label,
    );
    assert.match(component.id, ID, `${label}.id`);
    assert.ok(!ids.has(component.id), `${label}.id is duplicated`);
    ids.add(component.id);
    assert.ok(
      component.role === "resident" || component.role === "application",
      `${label}.role must be resident or application`,
    );
    validateSource(component.source, `${label}.source`);
    assert.match(component.recipe, ID, `${label}.recipe`);
    assert.ok(recipes.has(component.recipe), `${label}.recipe is not trusted`);
    if (component.source.kind === "prebuilt") {
      assert.equal(component.recipe, "verified-prebuilt", `${label}.recipe`);
    } else {
      assert.notEqual(component.recipe, "verified-prebuilt", `${label}.recipe`);
    }
    validateTarget(component.target, `${label}.target`);
    validateInstall(component.install, `${label}.install`);
    validateLicence(component.licence, `${label}.licence`);

    if (component.install.kind === "file") {
      assert.equal(component.role, "application", `${label}.role`);
      assert.ok(
        !filenames.has(component.install.name),
        `${label}.install.name is duplicated`,
      );
      filenames.add(component.install.name);
    } else {
      assert.equal(component.role, "resident", `${label}.role`);
      const first = component.install.firstRecord;
      const end = first + component.install.recordCount;
      assert.ok(
        end <= disk.systemRecords,
        `${label}.install exceeds system records`,
      );
      assert.equal(
        component.install.recordCount * disk.recordBytes,
        component.target.capacity,
        `${label}.install size differs from target capacity`,
      );
      for (const range of systemRanges) {
        assert.ok(
          end <= range.first || first >= range.end,
          `${label}.install overlaps ${range.id}`,
        );
      }
      systemRanges.push({ id: component.id, first, end });
      const origin = component.target.origin;
      const targetEnd = origin + component.target.capacity;
      for (const range of residentRanges) {
        assert.ok(
          targetEnd <= range.origin || origin >= range.end,
          `${label}.target overlaps ${range.id}`,
        );
      }
      residentRanges.push({ id: component.id, origin, end: targetEnd });
    }
  }
  return lock;
}
