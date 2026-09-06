// V4 describes saved media, not permission to boot a release. Runtime admission
// checks qualified component pins separately and must never rewrite saved bytes.
export const DRIVE_SET_V4_SCHEMA = "triptych-drive-set-v4";
const DISK_BYTES = 2097152;
const MAX_METADATA = 65536;
const MAX_ARCHIVE = 33620236;
const MAGIC = new TextEncoder().encode("TRPTYDS4");
const SHA256 = /^[0-9a-f]{64}$/;
const INSTANCE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const encoder = new TextEncoder();

function requireValue(condition, message) {
  if (!condition) throw new Error(`Drive set v4: ${message}.`);
}

function record(value, keys, label) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `invalid ${label}`,
  );
  requireValue(
    Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `unsupported ${label} fields`,
  );
}

// Inspect lengths before allocating. Shared buffers are excluded: another agent
// could change them while hashing, even after this caller has stopped writing.
function byteView(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer)
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new Error("Drive set v4: invalid bytes.");
}

function nameValue(value) {
  requireValue(
    typeof value === "string" && value.length > 0 && value.length <= 255,
    "invalid disk name",
  );
  for (const character of value) {
    const code = character.codePointAt(0);
    requireValue(
      code !== 0 && (code < 0xd800 || code > 0xdfff),
      "invalid disk name Unicode",
    );
  }
  requireValue(
    encoder.encode(value).length <= 255,
    "disk name exceeds 255 UTF-8 bytes",
  );
  return value;
}

function imageReference(value) {
  record(value, ["sha256", "byteLength"], "image reference");
  requireValue(
    typeof value.sha256 === "string" && SHA256.test(value.sha256),
    "invalid image hash",
  );
  requireValue(
    Number.isSafeInteger(value.byteLength) && value.byteLength > 0,
    "invalid image length",
  );
  return { sha256: value.sha256, byteLength: value.byteLength };
}

// This shared walk returns canonical field order but never copies media bytes.
function validate(value, manifest) {
  record(
    value,
    ["schema", "configuredCount", "bootstrap", "slots"],
    manifest ? "manifest" : "snapshot",
  );
  requireValue(value.schema === DRIVE_SET_V4_SCHEMA, "unsupported schema");
  const count = value.configuredCount;
  requireValue(
    Number.isInteger(count) && count >= 1 && count <= 16,
    "invalid configured count",
  );
  const field = manifest ? "image" : "bytes";
  record(value.bootstrap, ["profile", field], "bootstrap");
  requireValue(
    value.bootstrap.profile ===
      `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
    "unsupported or mismatched resident profile",
  );
  const payload = (item, length) => {
    const result = manifest ? imageReference(item) : byteView(item);
    requireValue(
      result.byteLength === length,
      `image must contain ${length} bytes`,
    );
    return result;
  };
  const bootstrap = {
    profile: value.bootstrap.profile,
    [field]: payload(value.bootstrap[field], 256),
  };
  requireValue(
    Array.isArray(value.slots) && value.slots.length === count,
    "invalid slots length",
  );
  requireValue(
    Reflect.ownKeys(value.slots).length === count + 1,
    "slots must be dense with no extra fields",
  );
  const identities = new Set();
  const slots = Array.from({ length: count }, (_, index) => {
    requireValue(Object.hasOwn(value.slots, index), "slots must be dense");
    const item = value.slots[index];
    if (item === null) {
      requireValue(index !== 0, "A media is required");
      return null;
    }
    record(item, ["instanceId", "name", field], "slot");
    requireValue(
      typeof item.instanceId === "string" && INSTANCE_ID.test(item.instanceId),
      "invalid instance ID",
    );
    requireValue(!identities.has(item.instanceId), "duplicate instance ID");
    identities.add(item.instanceId);
    return {
      instanceId: item.instanceId,
      name: nameValue(item.name),
      [field]: payload(item[field], DISK_BYTES),
    };
  });
  return {
    schema: DRIVE_SET_V4_SCHEMA,
    configuredCount: count,
    bootstrap,
    slots,
  };
}

/** Validate synchronously without copying payloads; not an ownership transfer. */
export function validateDriveSetSnapshotV4(value) {
  return validate(value, false);
}

/** Validate the entire snapshot, then own each slot independently before yielding. */
export function copyDriveSetV4(value) {
  const result = validateDriveSetSnapshotV4(value);
  result.bootstrap.bytes = result.bootstrap.bytes.slice();
  for (const slot of result.slots) if (slot) slot.bytes = slot.bytes.slice();
  return result;
}

function references(manifest) {
  const unique = new Map();
  for (const image of [
    manifest.bootstrap.image,
    ...manifest.slots.filter(Boolean).map((slot) => slot.image),
  ]) {
    const prior = unique.get(image.sha256);
    requireValue(
      !prior || prior.byteLength === image.byteLength,
      "conflicting image lengths",
    );
    unique.set(image.sha256, image);
  }
  // Hashes are lowercase ASCII; ordering must not depend on the host locale.
  return [...unique.values()].sort((a, b) =>
    a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0,
  );
}

/** Return a canonical, detached metadata tree; reject conflicting hash lengths. */
export function validateDriveSetManifestV4(value) {
  const manifest = validate(value, true);
  references(manifest);
  requireValue(
    encoder.encode(JSON.stringify(manifest)).length <= MAX_METADATA,
    "archive metadata exceeds 65536 bytes",
  );
  return manifest;
}

export function driveSetReferencesV4(value) {
  return references(validateDriveSetManifestV4(value));
}

async function hash(bytes, crypto) {
  requireValue(crypto?.subtle, "SHA-256 unavailable");
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function prepareDriveSetV4(value, crypto = globalThis.crypto) {
  const snapshot = copyDriveSetV4(value);
  const blobs = new Map();
  const reference = async (bytes) => {
    const sha256 = await hash(bytes, crypto);
    const prior = blobs.get(sha256);
    requireValue(
      !prior ||
        (prior.length === bytes.length &&
          prior.every((byte, index) => byte === bytes[index])),
      "image hash collision",
    );
    if (!prior) blobs.set(sha256, bytes);
    return { sha256, byteLength: bytes.length };
  };
  const bootstrap = {
    profile: snapshot.bootstrap.profile,
    image: await reference(snapshot.bootstrap.bytes),
  };
  const slots = [];
  for (const slot of snapshot.slots)
    slots.push(
      slot === null
        ? null
        : {
            instanceId: slot.instanceId,
            name: slot.name,
            image: await reference(slot.bytes),
          },
    );
  const manifest = validateDriveSetManifestV4({
    schema: DRIVE_SET_V4_SCHEMA,
    configuredCount: snapshot.configuredCount,
    bootstrap,
    slots,
  });
  const digest = await hash(encoder.encode(JSON.stringify(manifest)), crypto);
  return {
    snapshot,
    manifest,
    digest,
    blobs: [...blobs].map(([sha256, bytes]) => ({ sha256, bytes })),
  };
}

async function verifyImages(images, crypto) {
  for (const [sha256, bytes] of images)
    requireValue((await hash(bytes, crypto)) === sha256, "image hash mismatch");
}

// Restore can hand the first owned blob to a slot, copying only additional users.
// Archive views instead need one copy per output; no intermediate blob copies.
function snapshotFromImages(manifest, images, reuseOwned) {
  const used = new Set();
  const bytes = (image) => {
    const source = images.get(image.sha256);
    const reuse = reuseOwned && !used.has(image.sha256);
    used.add(image.sha256);
    return reuse ? source : source.slice();
  };
  return {
    schema: DRIVE_SET_V4_SCHEMA,
    configuredCount: manifest.configuredCount,
    bootstrap: {
      profile: manifest.bootstrap.profile,
      bytes: bytes(manifest.bootstrap.image),
    },
    slots: manifest.slots.map((slot) =>
      slot === null
        ? null
        : {
            instanceId: slot.instanceId,
            name: slot.name,
            bytes: bytes(slot.image),
          },
    ),
  };
}

export async function restoreDriveSetV4(
  value,
  blobs,
  crypto = globalThis.crypto,
) {
  const manifest = validateDriveSetManifestV4(value);
  requireValue(blobs instanceof Map, "invalid image collection");
  const views = new Map();
  for (const image of references(manifest)) {
    const view = byteView(blobs.get(image.sha256));
    requireValue(view.length === image.byteLength, "image length mismatch");
    views.set(image.sha256, view);
  }
  // Complete validation precedes all copies; all capture precedes the first hash.
  const images = new Map([...views].map(([key, view]) => [key, view.slice()]));
  await verifyImages(images, crypto);
  return snapshotFromImages(manifest, images, true);
}

export async function encodeDriveSetV4(value, crypto = globalThis.crypto) {
  const prepared = await prepareDriveSetV4(value, crypto);
  const metadata = encoder.encode(JSON.stringify(prepared.manifest));
  const refs = references(prepared.manifest);
  const length =
    12 +
    metadata.length +
    refs.reduce((sum, image) => sum + image.byteLength, 0);
  requireValue(length <= MAX_ARCHIVE, "archive exceeds maximum length");
  const output = new Uint8Array(length);
  output.set(MAGIC);
  new DataView(output.buffer).setUint32(8, metadata.length, true);
  output.set(metadata, 12);
  const images = new Map(
    prepared.blobs.map(({ sha256, bytes }) => [sha256, bytes]),
  );
  let offset = 12 + metadata.length;
  for (const image of refs) {
    output.set(images.get(image.sha256), offset);
    offset += image.byteLength;
  }
  return output;
}

export async function decodeDriveSetV4(value, crypto = globalThis.crypto) {
  const view = byteView(value);
  // Reject oversized input before making even one archive-sized copy.
  requireValue(view.length <= MAX_ARCHIVE, "archive exceeds maximum length");
  requireValue(
    view.length >= 12 && MAGIC.every((byte, index) => view[index] === byte),
    "invalid archive header",
  );
  const length = new DataView(
    view.buffer,
    view.byteOffset,
    view.byteLength,
  ).getUint32(8, true);
  requireValue(
    length > 0 && length <= MAX_METADATA && length <= view.length - 12,
    "invalid archive metadata length",
  );
  // Retain a BOM so JSON parsing rejects it, instead of admitting a second form.
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(view.subarray(12, 12 + length));
  const manifest = validateDriveSetManifestV4(JSON.parse(text));
  requireValue(
    JSON.stringify(manifest) === text,
    "noncanonical archive metadata",
  );
  const refs = references(manifest);
  const expected =
    12 + length + refs.reduce((sum, image) => sum + image.byteLength, 0);
  requireValue(expected === view.length, "archive payload length mismatch");
  // One private archive copy protects all payloads across asynchronous hashes.
  const owned = view.slice();
  const images = new Map();
  let offset = 12 + length;
  for (const image of refs) {
    images.set(image.sha256, owned.subarray(offset, offset + image.byteLength));
    offset += image.byteLength;
  }
  await verifyImages(images, crypto);
  return snapshotFromImages(manifest, images, false);
}
