const SCHEMA = "triptych-disk-catalogue-v1";
const MAX_BYTES = 8388608;
const MAX_IMAGES = 4096;
const encoder = new TextEncoder();
const FIELDS = [
  "id",
  "revision",
  "name",
  "geometry",
  "byteLength",
  "sha256",
  "source",
  "license",
  "systemProfile",
];
const SIZES = new Map([
  ["ibm3740", 256512],
  ["triptych-cpm-2m-v1", 2097152],
  ["triptych-cpm-8m-v1", MAX_BYTES],
]);

function requireValue(condition, message) {
  if (!condition) throw new Error(`Disk catalogue: ${message}.`);
}

// Only own data fields are accepted. Accessors could change identity between
// validation and capture; symbols and extra array properties are not wire data.
function record(value, keys) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid record",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(
    Reflect.ownKeys(descriptors).length === keys.length &&
      keys.every(
        (key) =>
          Object.hasOwn(descriptors, key) &&
          Object.hasOwn(descriptors[key], "value"),
      ),
    "unsupported fields or accessors",
  );
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}

function identity(value) {
  requireValue(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    "invalid identity",
  );
  return value;
}

function human(value, limit, label) {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= limit &&
      !/[\u0000-\u001f\u007f]/.test(value),
    `invalid ${label}`,
  );
  for (const character of value) {
    const code = character.codePointAt(0);
    requireValue(code < 0xd800 || code > 0xdfff, `invalid ${label} Unicode`);
  }
  requireValue(
    encoder.encode(value).length <= limit,
    `${label} exceeds byte limit`,
  );
  return value;
}

function absoluteUrl(value) {
  requireValue(
    typeof value === "string" &&
      /^https?:\/\//i.test(value) &&
      value === value.trim() &&
      !/[\u0000-\u0020\u007f\\#]/.test(value) &&
      value.length <= 4096,
    "invalid URL",
  );
  const url = new URL(value);
  requireValue(
    ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "invalid URL authority",
  );
  return url.href;
}

function metadata(value) {
  const id = identity(value.id),
    revision = identity(value.revision);
  const name = human(value.name, 255, "name");
  requireValue(
    SIZES.has(value.geometry) && value.byteLength === SIZES.get(value.geometry),
    "unsupported geometry or image length",
  );
  requireValue(
    typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256),
    "invalid image hash",
  );
  const profile = value.systemProfile;
  const matched =
    value.geometry === "ibm3740"
      ? profile === "legacy-e400"
      : value.geometry === "triptych-cpm-8m-v1"
        ? ["triptych-cpu-v0.1-8m-a", "triptych-cpu-v0.1-8m-ab"].includes(
            profile,
          )
        : typeof profile === "string" &&
          /^triptych-cpu-v0\.1-2m-n(?:0[1-9]|1[0-6])$/.test(profile);
  requireValue(
    profile === null || matched,
    "resident profile does not match geometry",
  );
  return {
    id,
    revision,
    name,
    geometry: value.geometry,
    byteLength: value.byteLength,
    sha256: value.sha256,
    source: absoluteUrl(value.source),
    license: human(value.license, 4096, "license"),
    systemProfile: profile,
  };
}

/** Detached metadata only; legacy images must already be sector-padded. Raw
 * 256256-byte IBM3740 imports need explicit conversion outside this boundary.
 * Declared profiles are identities, not executable compatibility proofs.
 */
export function validateDiskCatalogue(value) {
  const input = record(value, ["schema", "images"]);
  requireValue(input.schema === SCHEMA, "unsupported schema");
  requireValue(
    Array.isArray(input.images) && input.images.length <= MAX_IMAGES,
    "invalid images array",
  );
  const descriptors = Object.getOwnPropertyDescriptors(input.images);
  requireValue(
    Reflect.ownKeys(descriptors).length === input.images.length + 1,
    "sparse or extended images array",
  );
  const identities = new Set();
  const images = Array.from({ length: input.images.length }, (_, index) => {
    requireValue(
      Object.hasOwn(descriptors, index) &&
        Object.hasOwn(descriptors[index], "value"),
      "sparse images or accessors",
    );
    const row = record(descriptors[index].value, [...FIELDS, "asset"]);
    const image = metadata(row);
    requireValue(
      typeof row.asset === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.asset),
      "invalid asset filename",
    );
    const key = `${image.id}:${image.revision}`;
    requireValue(!identities.has(key), "duplicate image identity");
    identities.add(key);
    return { ...image, asset: row.asset };
  });
  return { schema: SCHEMA, images };
}

export function validatePublishedImageReference(value) {
  const row = record(value, [...FIELDS, "url"]);
  return { ...metadata(row), url: absoluteUrl(row.url) };
}

export function publishedImageReference(catalogue, id, revision, baseUrl) {
  identity(id);
  identity(revision);
  const { images } = validateDiskCatalogue(catalogue);
  const image = images.find(
    (entry) => entry.id === id && entry.revision === revision,
  );
  requireValue(image, "missing image identity");
  const { asset, ...reference } = image;
  return validatePublishedImageReference({
    ...reference,
    url: new URL(asset, absoluteUrl(baseUrl)).href,
  });
}

/** Fetch complete immutable bytes without a database or persistent cache. Copy
 * metadata before the first await, and every chunk before requesting another.
 * The caller still validates CP/M directory/geometry and resident compatibility.
 */
export async function fetchPublishedImage(
  reference,
  { fetch = globalThis.fetch, crypto = globalThis.crypto } = {},
) {
  const image = validatePublishedImageReference(reference);
  requireValue(
    typeof fetch === "function" && crypto?.subtle,
    "fetch or SHA-256 unavailable",
  );
  const response = await fetch(image.url, {
    redirect: "error",
    cache: "no-store",
  });
  let reader;
  try {
    requireValue(response?.ok, "image request failed");
    requireValue(!response.redirected, "redirected image rejected");
    if (response.url)
      requireValue(
        absoluteUrl(response.url) === image.url,
        "response URL changed",
      );
    const length = response.headers.get("content-length");
    if (length !== null)
      requireValue(
        /^(?:0|[1-9][0-9]*)$/.test(length) &&
          Number(length) <= MAX_BYTES &&
          Number(length) === image.byteLength,
        "content length exceeds bounds or differs",
      );
    requireValue(
      response.body && typeof response.body.getReader === "function",
      "missing streaming image body",
    );
    reader = response.body.getReader();
    const bytes = new Uint8Array(image.byteLength);
    let offset = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      requireValue(
        value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
        "invalid stream chunk",
      );
      requireValue(
        value.byteLength <= image.byteLength - offset &&
          value.byteLength <= MAX_BYTES - offset,
        "stream length exceeds bounds",
      );
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    requireValue(offset === image.byteLength, "image length differs");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    requireValue(digest === image.sha256, "image hash differs");
    return bytes;
  } catch (error) {
    try {
      if (reader) await reader.cancel();
      else if (response?.body) await response.body.cancel();
    } catch {
      /* Preserve the verification failure over cleanup errors. */
    }
    throw error;
  } finally {
    reader?.releaseLock();
  }
}
