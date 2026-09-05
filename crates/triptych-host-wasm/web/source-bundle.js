const SCHEMA = "triptych-nucleus-source-bundle-v1";
const MAX_BYTES = 65535;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Source bundle: ${message}`);
}

function canonicalIdentity(name, canonicalName) {
  requireValue(typeof name === "string", "a source/output name is required");
  requireValue(canonicalName(name) === name, `${name} is not canonical`);
  return name;
}

function copyBytes(bytes, name) {
  requireValue(bytes instanceof Uint8Array, `${name} is missing source bytes`);
  return new Uint8Array(bytes);
}

// CP/M records do not carry a text byte length. Accept its text EOF convention
// only when every remaining byte is padding; never hide data after an EOF byte.
function unpad(bytes, name) {
  const end = bytes.indexOf(26);
  if (end < 0) return bytes;
  requireValue(
    bytes.subarray(end).every((byte) => byte === 26),
    `${name} has non-padding bytes after CP/M EOF`,
  );
  return bytes.subarray(0, end);
}

// This is a boundary guard, not a replacement Nucleus lexer/parser. Nucleus's
// only comment form is //; it is complete at EOF. Do not invent block comments
// or resolve //% import directives. Grammar and type errors belong to NUC.
function checkBoundary(bytes, name) {
  const delimiters = [];
  let quote = 0;
  let escaped = false;
  let comment = false;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    requireValue(
      byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126),
      `${name} has unsupported source byte at ${index}`,
    );
    requireValue(
      byte !== 13 || bytes[index + 1] === 10,
      `${name} has lone CR at ${index}`,
    );
    if (comment) {
      if (byte === 10 || byte === 13) comment = false;
      continue;
    }
    if (quote) {
      requireValue(
        byte !== 10 && byte !== 13,
        `${name} has unterminated literal`,
      );
      if (escaped) escaped = false;
      else if (byte === 92) escaped = true;
      else if (byte === quote) quote = 0;
      continue;
    }
    if (byte === 47 && bytes[index + 1] === 47) comment = true;
    else if (byte === 34 || byte === 39) quote = byte;
    else if (byte === 40 || byte === 91) delimiters.push(byte);
    else if (byte === 41 || byte === 93) {
      requireValue(
        delimiters.pop() === (byte === 41 ? 40 : 91),
        `${name} has mismatched delimiter at ${index}`,
      );
    }
  }
  requireValue(
    quote === 0,
    `${name} has unterminated literal at source boundary`,
  );
  requireValue(delimiters.length === 0, `${name} ends inside a delimiter`);
}

async function sha256(bytes, crypto) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Package an explicit, already ordered snapshot for released single-file NUC.
 * The caller owns CP/M naming, stable disk reads, replacement consent and atomic
 * installation. No import discovery, compiler multipart identity or persistence
 * is implied. All input bytes are copied before the first asynchronous step.
 * Empty parts are rejected as an authoring safeguard, not a language rule.
 */
export async function prepareSourceBundle(
  { sources, outputName },
  { canonicalName, crypto = globalThis.crypto } = {},
) {
  requireValue(
    typeof canonicalName === "function",
    "canonicalName is required",
  );
  requireValue(crypto?.subtle?.digest, "SHA-256 is unavailable");
  const name = canonicalIdentity(outputName, canonicalName);
  requireValue(
    Array.isArray(sources) && sources.length > 0,
    "sources are required",
  );
  const identities = new Set([name]);
  let length = 0;
  const parts = sources.map((source) => {
    requireValue(
      source !== null && typeof source === "object",
      "missing source",
    );
    const identity = canonicalIdentity(source.name, canonicalName);
    requireValue(
      !identities.has(identity),
      `duplicate or colliding name ${identity}`,
    );
    identities.add(identity);
    const stored = copyBytes(source.bytes, identity);
    const bytes = unpad(stored, identity);
    requireValue(bytes.length > 0, `${identity} is empty`);
    requireValue(
      bytes.length <= MAX_BYTES,
      `${identity} exceeds source capacity`,
    );
    checkBoundary(bytes, identity);
    const start = length;
    const addedNewline = bytes.at(-1) !== 10;
    length += bytes.length + Number(addedNewline);
    requireValue(
      length <= MAX_BYTES,
      "generated source exceeds 65535-byte capacity",
    );
    return { name: identity, stored, bytes, start, addedNewline };
  });
  const bytes = new Uint8Array(length);
  for (const part of parts) {
    bytes.set(part.bytes, part.start);
    if (part.addedNewline) bytes[part.start + part.bytes.length] = 10;
  }
  const map = {
    schema: SCHEMA,
    outputName: name,
    bytes: length,
    sha256: await sha256(bytes, crypto),
    sources: await Promise.all(
      parts.map(async (part) => ({
        name: part.name,
        start: part.start,
        end: part.start + part.bytes.length,
        addedNewline: part.addedNewline,
        sha256: await sha256(part.bytes, crypto),
        storedBytes: part.stored.length,
        storedSha256: await sha256(part.stored, crypto),
      })),
    ),
  };
  return { name, bytes, map };
}

/**
 * Translate a zero-based offset from NUC's ONE physical generated source.
 * Rebuild and compare the complete map against current inputs and bundle before
 * trusting any offsets. CP/M padding on the generated file is accepted; changes
 * to source records (including their padding) invalidate the previous map.
 * Synthetic final LF maps to the original part's EOF with synthetic=true.
 */
export async function mapSourceBundleOffset(
  { sources, bundle, map, offset },
  options,
) {
  requireValue(
    Number.isInteger(offset) && offset >= 0,
    "invalid diagnostic offset",
  );
  requireValue(
    bundle !== null && typeof bundle === "object",
    "bundle is required",
  );
  const name = bundle.name;
  const current = unpad(copyBytes(bundle.bytes, name), name);
  const expectedMap = JSON.stringify(map);
  const rebuilt = await prepareSourceBundle(
    { sources, outputName: name },
    options,
  );
  requireValue(
    expectedMap === JSON.stringify(rebuilt.map) &&
      current.length === rebuilt.bytes.length &&
      current.every((byte, index) => byte === rebuilt.bytes[index]),
    "source map is stale or does not match current inputs and generated source",
  );
  requireValue(
    offset <= current.length,
    "diagnostic offset is outside generated source",
  );
  const parts = rebuilt.map.sources;
  const part = parts.find((entry, index) => {
    const next = parts[index + 1];
    return offset >= entry.start && (next ? offset < next.start : true);
  });
  const sourceOffset = Math.min(offset, part.end) - part.start;
  let line = 1;
  let column = 1;
  for (let index = part.start; index < part.start + sourceOffset; index += 1) {
    if (current[index] === 10) {
      line += 1;
      column = 1;
    } else column += 1;
  }
  return {
    name: part.name,
    offset: sourceOffset,
    line,
    column,
    synthetic: part.addedNewline && offset >= part.end,
  };
}
