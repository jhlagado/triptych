// Complete saved-machine media. Geometry is a compatibility check, never a
// detector for the resident system or a reason to rewrite saved bytes.
export const DRIVE_SET_SCHEMA = "triptych-drive-set-v3";
const LARGE_BYTES = 8388608;
const SHA256 = /^[0-9a-f]{64}$/;
const MAGIC = new TextEncoder().encode("TRPTYDS3");
const MAX_MANIFEST_BYTES = 1048576;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Drive set: ${message}.`);
}

function record(value, keys, label) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `invalid ${label}`,
  );
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `unsupported ${label} fields`,
  );
}

function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value))
    return new Uint8Array(
      value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength),
    );
  throw new Error("Drive set: invalid bytes.");
}

function validName(name) {
  requireValue(
    typeof name === "string" && name.length > 0,
    "invalid disk name",
  );
  return name;
}

function profile(value, aBytes, bBytes) {
  requireValue(
    [
      "legacy-e400",
      "triptych-cpu-v0.1-8m-a",
      "triptych-cpu-v0.1-8m-ab",
    ].includes(value),
    "unsupported resident profile",
  );
  if (value === "legacy-e400") {
    // The old decoder accepted aligned images without inspecting their OS.
    // Retain that recovery domain rather than guess a profile from capacity.
    requireValue(
      Number.isSafeInteger(aBytes) && aBytes > 0 && aBytes % 512 === 0,
      "invalid legacy disk length",
    );
  } else {
    requireValue(aBytes === LARGE_BYTES, "A requires an eight MiB image");
  }
  requireValue(
    bBytes === null ||
      (value === "triptych-cpu-v0.1-8m-ab" && bBytes === LARGE_BYTES),
    "B requires the A/B resident profile and an eight MiB image",
  );
  return value;
}

/** Copy every byte before an asynchronous operation can yield to the caller. */
export function copyDriveSet(value) {
  record(value, ["bootstrap", "drives"], "snapshot");
  record(value.bootstrap, ["profile", "bytes"], "bootstrap");
  record(value.drives, ["A", "B"], "drives");
  const disk = (item) => {
    record(item, ["name", "bytes"], "disk");
    return { name: validName(item.name), bytes: copyBytes(item.bytes) };
  };
  const A = disk(value.drives.A);
  const B = value.drives.B === null ? null : disk(value.drives.B);
  const bytes = copyBytes(value.bootstrap.bytes);
  requireValue(bytes.length === 256, "bootstrap must contain 256 bytes");
  return {
    bootstrap: {
      profile: profile(
        value.bootstrap.profile,
        A.bytes.length,
        B?.bytes.length ?? null,
      ),
      bytes,
    },
    drives: { A, B },
  };
}

/** The fixed field order is also the canonical manifest serialization order. */
export function validateDriveSetManifest(value) {
  record(value, ["schema", "bootstrap", "drives"], "manifest");
  requireValue(value.schema === DRIVE_SET_SCHEMA, "unsupported schema");
  record(value.bootstrap, ["profile", "image"], "bootstrap reference");
  record(value.drives, ["A", "B"], "drive references");
  const reference = (item) => {
    record(item, ["sha256", "byteLength"], "image reference");
    requireValue(
      typeof item.sha256 === "string" &&
        SHA256.test(item.sha256) &&
        Number.isSafeInteger(item.byteLength) &&
        item.byteLength > 0,
      "invalid image reference",
    );
    return { sha256: item.sha256, byteLength: item.byteLength };
  };
  const disk = (item) => {
    record(item, ["name", "image"], "disk reference");
    return { name: validName(item.name), image: reference(item.image) };
  };
  const A = disk(value.drives.A);
  const B = value.drives.B === null ? null : disk(value.drives.B);
  const image = reference(value.bootstrap.image);
  requireValue(image.byteLength === 256, "invalid bootstrap reference length");
  const result = {
    schema: DRIVE_SET_SCHEMA,
    bootstrap: {
      profile: profile(
        value.bootstrap.profile,
        A.image.byteLength,
        B?.image.byteLength ?? null,
      ),
      image,
    },
    drives: { A, B },
  };
  uniqueReferences(result); // A shared hash cannot declare two different lengths.
  return result;
}

function uniqueReferences(manifest) {
  const images = new Map();
  for (const image of [
    manifest.bootstrap.image,
    manifest.drives.A.image,
    manifest.drives.B?.image,
  ]) {
    if (!image) continue;
    const previous = images.get(image.sha256);
    requireValue(
      !previous || previous.byteLength === image.byteLength,
      "conflicting image lengths",
    );
    images.set(image.sha256, image);
  }
  return [...images.values()].sort((a, b) => a.sha256.localeCompare(b.sha256));
}

async function hash(bytes, crypto) {
  requireValue(crypto?.subtle, "SHA-256 unavailable");
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function prepareDriveSet(value, crypto = globalThis.crypto) {
  const snapshot = copyDriveSet(value);
  const blobs = new Map();
  const reference = async (bytes) => {
    const sha256 = await hash(bytes, crypto);
    const previous = blobs.get(sha256);
    requireValue(
      !previous ||
        (previous.length === bytes.length &&
          previous.every((byte, i) => byte === bytes[i])),
      "image hash collision",
    );
    blobs.set(sha256, bytes);
    return { sha256, byteLength: bytes.length };
  };
  const image = await reference(snapshot.bootstrap.bytes);
  const A = {
    name: snapshot.drives.A.name,
    image: await reference(snapshot.drives.A.bytes),
  };
  const B =
    snapshot.drives.B === null
      ? null
      : {
          name: snapshot.drives.B.name,
          image: await reference(snapshot.drives.B.bytes),
        };
  const manifest = validateDriveSetManifest({
    schema: DRIVE_SET_SCHEMA,
    bootstrap: { profile: snapshot.bootstrap.profile, image },
    drives: { A, B },
  });
  const digest = await hash(
    new TextEncoder().encode(JSON.stringify(manifest)),
    crypto,
  );
  return {
    snapshot,
    manifest,
    digest,
    blobs: [...blobs].map(([sha256, bytes]) => ({ sha256, bytes })),
  };
}

export async function restoreDriveSet(
  manifestValue,
  blobs,
  crypto = globalThis.crypto,
) {
  const manifest = validateDriveSetManifest(manifestValue);
  requireValue(blobs instanceof Map, "invalid image collection");
  const copies = new Map();
  for (const image of uniqueReferences(manifest)) {
    const bytes = copyBytes(blobs.get(image.sha256));
    requireValue(bytes.length === image.byteLength, "image length mismatch");
    copies.set(image.sha256, bytes);
  }
  for (const [sha256, bytes] of copies)
    requireValue((await hash(bytes, crypto)) === sha256, "image hash mismatch");
  const disk = (item) => ({
    name: item.name,
    bytes: copies.get(item.image.sha256),
  });
  // Independent A/B arrays even when their initial contents are identical.
  return copyDriveSet({
    bootstrap: {
      profile: manifest.bootstrap.profile,
      bytes: copies.get(manifest.bootstrap.image.sha256),
    },
    drives: {
      A: disk(manifest.drives.A),
      B: manifest.drives.B === null ? null : disk(manifest.drives.B),
    },
  });
}

/** Portable complete-set recovery, independent of IndexedDB, WASM and downloads. */
export async function encodeDriveSet(value, crypto = globalThis.crypto) {
  const prepared = await prepareDriveSet(value, crypto);
  const metadata = new TextEncoder().encode(JSON.stringify(prepared.manifest));
  requireValue(
    metadata.length <= MAX_MANIFEST_BYTES,
    "archive metadata exceeds one MiB",
  );
  const references = uniqueReferences(prepared.manifest);
  const size =
    12 +
    metadata.length +
    references.reduce((sum, image) => sum + image.byteLength, 0);
  requireValue(Number.isSafeInteger(size), "archive length overflow");
  const output = new Uint8Array(size);
  output.set(MAGIC);
  new DataView(output.buffer).setUint32(8, metadata.length, true);
  output.set(metadata, 12);
  const images = new Map(
    prepared.blobs.map(({ sha256, bytes }) => [sha256, bytes]),
  );
  let offset = 12 + metadata.length;
  for (const image of references) {
    output.set(images.get(image.sha256), offset);
    offset += image.byteLength;
  }
  return output;
}

export async function decodeDriveSet(value, crypto = globalThis.crypto) {
  const bytes = copyBytes(value);
  requireValue(
    bytes.length >= 12 && MAGIC.every((byte, i) => bytes[i] === byte),
    "invalid archive header",
  );
  const length = new DataView(bytes.buffer).getUint32(8, true);
  requireValue(
    length > 0 && length <= MAX_MANIFEST_BYTES && length <= bytes.length - 12,
    "invalid archive metadata length",
  );
  // Preserve any BOM in decoded text so JSON parsing rejects it. Stripping it
  // would admit two different archive byte strings for one canonical manifest.
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes.subarray(12, 12 + length));
  const manifest = validateDriveSetManifest(JSON.parse(text));
  requireValue(
    JSON.stringify(manifest) === text,
    "noncanonical archive metadata",
  );
  const images = new Map();
  let offset = 12 + length;
  for (const image of uniqueReferences(manifest)) {
    requireValue(
      image.byteLength <= bytes.length - offset,
      "truncated archive image",
    );
    images.set(image.sha256, bytes.subarray(offset, offset + image.byteLength));
    offset += image.byteLength;
  }
  requireValue(offset === bytes.length, "unexpected archive trailing bytes");
  return restoreDriveSet(manifest, images, crypto);
}
