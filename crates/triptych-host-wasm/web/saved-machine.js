// Version dispatch only. Legacy snapshots and archives retain their v3 shape;
// conversion to a new machine profile is a separate, explicit operation.
import {
  DRIVE_SET_SCHEMA,
  copyDriveSet,
  prepareDriveSet,
  restoreDriveSet,
  validateDriveSetManifest,
  encodeDriveSet,
  decodeDriveSet,
} from "./drive-set.js";
import {
  DRIVE_SET_V4_SCHEMA,
  copyDriveSetV4,
  validateDriveSetSnapshotV4,
  validateDriveSetManifestV4,
  driveSetReferencesV4,
  prepareDriveSetV4,
  restoreDriveSetV4,
  encodeDriveSetV4,
  decodeDriveSetV4,
} from "./drive-set-v4.js";

function requireValue(condition, message) {
  if (!condition) throw new Error(`Saved machine: ${message}.`);
}

function snapshotVersion(value) {
  requireValue(value !== null && typeof value === "object", "invalid snapshot");
  if (!Object.hasOwn(value, "schema")) return 3;
  requireValue(
    value.schema === DRIVE_SET_V4_SCHEMA,
    "unsupported snapshot schema",
  );
  return 4;
}

function manifestVersion(value) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, "schema"),
    "missing manifest schema",
  );
  if (value.schema === DRIVE_SET_SCHEMA) return 3;
  requireValue(
    value.schema === DRIVE_SET_V4_SCHEMA,
    "unsupported manifest schema",
  );
  return 4;
}

export function copySavedMachine(value) {
  return snapshotVersion(value) === 3
    ? copyDriveSet(value)
    : copyDriveSetV4(value);
}

export function prepareSavedMachine(value, crypto = globalThis.crypto) {
  return snapshotVersion(value) === 3
    ? prepareDriveSet(value, crypto)
    : prepareDriveSetV4(value, crypto);
}

export function validateSavedMachineManifest(value) {
  return manifestVersion(value) === 3
    ? validateDriveSetManifest(value)
    : validateDriveSetManifestV4(value);
}

export function savedMachineReferences(value) {
  const manifest = validateSavedMachineManifest(value);
  if (manifest.schema === DRIVE_SET_V4_SCHEMA)
    return driveSetReferencesV4(manifest);
  const references = new Map();
  for (const image of [
    manifest.bootstrap.image,
    manifest.drives.A.image,
    ...(manifest.drives.B ? [manifest.drives.B.image] : []),
  ])
    references.set(image.sha256, image);
  return [...references.values()].sort((a, b) =>
    a.sha256.localeCompare(b.sha256),
  );
}

export function restoreSavedMachine(
  manifest,
  blobs,
  crypto = globalThis.crypto,
) {
  return manifestVersion(manifest) === 3
    ? restoreDriveSet(manifest, blobs, crypto)
    : restoreDriveSetV4(manifest, blobs, crypto);
}

export function encodeSavedMachine(value, crypto = globalThis.crypto) {
  return snapshotVersion(value) === 3
    ? encodeDriveSet(value, crypto)
    : encodeDriveSetV4(value, crypto);
}

// A view for synchronous validation/comparison, never async ownership. Match
// the old codec's accepted ArrayBuffer/view domain, including view offsets.
function byteView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value))
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Saved machine: invalid bytes.");
}

export function decodeSavedMachineArchive(value, crypto = globalThis.crypto) {
  const bytes = byteView(value);
  requireValue(bytes.length >= 8, "invalid archive header");
  const prefix = [84, 82, 80, 84, 89, 68, 83]; // TRPTYDS
  requireValue(
    prefix.every((byte, index) => bytes[index] === byte),
    "invalid archive header",
  );
  if (bytes[7] === 51) return decodeDriveSet(value, crypto);
  if (bytes[7] === 52) return decodeDriveSetV4(value, crypto);
  throw new Error("Saved machine: unsupported archive version.");
}

function record(value, keys) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    "invalid legacy snapshot fields",
  );
}

// The frozen v3 codec exports a copying validator only. Keep this small
// synchronous view validator equivalent to that codec, so equality need not
// clone two whole A/B images. Parity tests cover its legacy recovery domain.
function legacySnapshotView(value) {
  record(value, ["bootstrap", "drives"]);
  record(value.bootstrap, ["profile", "bytes"]);
  record(value.drives, ["A", "B"]);
  const disk = (item) => {
    record(item, ["name", "bytes"]);
    requireValue(
      typeof item.name === "string" && item.name.length > 0,
      "invalid legacy disk name",
    );
    return { name: item.name, bytes: byteView(item.bytes) };
  };
  const A = disk(value.drives.A);
  const B = value.drives.B === null ? null : disk(value.drives.B);
  const bytes = byteView(value.bootstrap.bytes);
  const profile = value.bootstrap.profile;
  requireValue(bytes.length === 256, "invalid legacy bootstrap length");
  requireValue(
    [
      "legacy-e400",
      "triptych-cpu-v0.1-8m-a",
      "triptych-cpu-v0.1-8m-ab",
    ].includes(profile),
    "unsupported legacy profile",
  );
  requireValue(
    profile === "legacy-e400"
      ? A.bytes.length > 0 && A.bytes.length % 512 === 0
      : A.bytes.length === 8388608,
    "invalid legacy A length",
  );
  requireValue(
    B === null ||
      (profile === "triptych-cpu-v0.1-8m-ab" && B.bytes.length === 8388608),
    "invalid legacy B profile or length",
  );
  return { bootstrap: { profile, bytes }, drives: { A, B } };
}

const sameBytes = (a, b) =>
  a.length === b.length && a.every((byte, index) => byte === b[index]);
function sameDisk(a, b, withIdentity) {
  if (a === null || b === null) return a === b;
  return (
    (!withIdentity || a.instanceId === b.instanceId) &&
    a.name === b.name &&
    sameBytes(a.bytes, b.bytes)
  );
}

/** Validate both snapshots, then compare all identity fields without cloning
 * payloads. Callers must not mutate buffers concurrently with this sync read.
 */
export function sameSavedMachine(left, right) {
  const leftVersion = snapshotVersion(left),
    rightVersion = snapshotVersion(right);
  const a =
    leftVersion === 3
      ? legacySnapshotView(left)
      : validateDriveSetSnapshotV4(left);
  const b =
    rightVersion === 3
      ? legacySnapshotView(right)
      : validateDriveSetSnapshotV4(right);
  if (leftVersion !== rightVersion) return false;
  if (
    a.bootstrap.profile !== b.bootstrap.profile ||
    !sameBytes(a.bootstrap.bytes, b.bootstrap.bytes)
  )
    return false;
  if (leftVersion === 3)
    return (
      sameDisk(a.drives.A, b.drives.A, false) &&
      sameDisk(a.drives.B, b.drives.B, false)
    );
  return (
    a.configuredCount === b.configuredCount &&
    a.slots.every((slot, index) => sameDisk(slot, b.slots[index], true))
  );
}
