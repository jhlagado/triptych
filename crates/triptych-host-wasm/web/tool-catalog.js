const TOOLS = { atom: "ATOM.COM", nucleus: "NUC.COM", edit: "EDIT.COM" };
const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Tool catalog: ${message}`);
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function digest(value) {
  return typeof value === "string" && SHA256.test(value);
}

function sourceMatches(source, expected, id) {
  return (
    object(source) &&
    object(expected) &&
    source.kind === "git" &&
    source.kind === expected.kind &&
    source.repository === `https://github.com/jhlagado/${id}.git` &&
    source.repository === expected.repository &&
    typeof source.revision === "string" &&
    REVISION.test(source.revision) &&
    source.revision === expected.revision &&
    typeof source.path === "string" &&
    source.path.length > 0 &&
    source.path === expected.path
  );
}

/**
 * Validate against the current site's complete distribution manifest, not a
 * version supplied by the catalog. Return an isolated, immutable description
 * so callers cannot change a target while asynchronous verification runs.
 * These hashes detect deployment mismatches; they are not release signatures.
 */
export function validateToolCatalog(catalog, expectedDistribution) {
  const manifest = expectedDistribution;
  requireValue(object(manifest), "distribution manifest is required");
  requireValue(
    manifest.schema === "triptych-cpm-distribution-v1" &&
      manifest.targetProfile === "triptych-cpu-v0.1" &&
      object(manifest.triptych) &&
      typeof manifest.triptych.revision === "string" &&
      REVISION.test(manifest.triptych.revision) &&
      digest(manifest.lockSha256) &&
      object(manifest.disk) &&
      manifest.disk.bytes === 256512 &&
      manifest.disk.logicalBytes === 256256 &&
      digest(manifest.disk.sha256) &&
      Array.isArray(manifest.components),
    "invalid distribution identity or target",
  );
  const components = new Map();
  for (const component of manifest.components) {
    requireValue(
      object(component) &&
        typeof component.id === "string" &&
        !components.has(component.id),
      "invalid or duplicate distribution component",
    );
    components.set(component.id, component);
  }
  requireValue(
    object(catalog) &&
      catalog.schema === "triptych-browser-tools-v1" &&
      catalog.targetProfile === manifest.targetProfile &&
      object(catalog.distribution) &&
      catalog.distribution.revision === manifest.triptych.revision &&
      catalog.distribution.lockSha256 === manifest.lockSha256 &&
      catalog.distribution.diskSha256 === manifest.disk.sha256 &&
      Array.isArray(catalog.tools) &&
      catalog.tools.length === Object.keys(TOOLS).length,
    "catalog does not match this distribution",
  );
  const ids = new Set();
  const tools = catalog.tools.map((tool) => {
    requireValue(
      object(tool) && Object.hasOwn(TOOLS, tool.id) && !ids.has(tool.id),
      "unknown or duplicate tool",
    );
    ids.add(tool.id);
    const pinned = components.get(tool.id);
    requireValue(object(pinned), `missing pinned ${tool.id}`);
    requireValue(
      sourceMatches(tool.source, pinned.source, tool.id) &&
        object(tool.target) &&
        object(pinned.target) &&
        tool.target.origin === 256 &&
        tool.target.origin === pinned.target.origin &&
        Number.isSafeInteger(tool.target.capacity) &&
        tool.target.capacity > 0 &&
        tool.target.capacity <= 0xe300 &&
        tool.target.capacity === pinned.target.capacity &&
        object(pinned.install) &&
        pinned.install.kind === "file" &&
        pinned.install.name === TOOLS[tool.id] &&
        tool.name === pinned.install.name &&
        tool.padByte === 26 &&
        tool.padByte === pinned.install.padByte,
      `wrong source, target or filename for ${tool.id}`,
    );
    requireValue(
      object(tool.raw) &&
        Number.isSafeInteger(tool.raw.bytes) &&
        tool.raw.bytes > 0 &&
        tool.raw.bytes <= tool.target.capacity &&
        tool.raw.bytes === pinned.bytes &&
        digest(tool.raw.sha256) &&
        tool.raw.sha256 === pinned.sha256 &&
        object(tool.padded) &&
        tool.padded.bytes === Math.ceil(tool.raw.bytes / 128) * 128 &&
        digest(tool.padded.sha256) &&
        tool.asset === `tool-${tool.id}-${tool.padded.sha256}.com`,
      `invalid artifact identity for ${tool.id}`,
    );
    return Object.freeze({
      id: tool.id,
      name: tool.name,
      source: Object.freeze({
        kind: tool.source.kind,
        repository: tool.source.repository,
        revision: tool.source.revision,
        path: tool.source.path,
      }),
      target: Object.freeze({ ...tool.target }),
      raw: Object.freeze({ ...tool.raw }),
      padded: Object.freeze({ ...tool.padded }),
      padByte: tool.padByte,
      asset: tool.asset,
    });
  });
  return Object.freeze({
    schema: catalog.schema,
    targetProfile: catalog.targetProfile,
    distribution: Object.freeze({ ...catalog.distribution }),
    tools: Object.freeze(tools),
  });
}

async function sha256(bytes, crypto) {
  requireValue(crypto?.subtle, "Web Crypto SHA-256 is unavailable");
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

async function matchesArtifact(tool, bytes, crypto) {
  if (bytes.length !== tool.padded.bytes) return false;
  if (!bytes.subarray(tool.raw.bytes).every((byte) => byte === tool.padByte)) {
    return false;
  }
  return (
    (await sha256(bytes, crypto)) === tool.padded.sha256 &&
    (await sha256(bytes.subarray(0, tool.raw.bytes), crypto)) ===
      tool.raw.sha256
  );
}

/**
 * readFile returns full CP/M records, or undefined only for an absent file.
 * Filesystem/corruption errors propagate; they must not masquerade as absence.
 */
export async function identifyInstalledTools(
  catalog,
  readFile,
  { expectedDistribution, crypto = globalThis.crypto } = {},
) {
  const checked = validateToolCatalog(catalog, expectedDistribution);
  return Promise.all(
    checked.tools.map(async (tool) => {
      const content = await readFile(tool.name);
      requireValue(
        content === undefined || content instanceof Uint8Array,
        `invalid installed bytes for ${tool.name}`,
      );
      const bytes = content?.slice();
      return {
        id: tool.id,
        name: tool.name,
        status:
          bytes === undefined
            ? "missing"
            : (await matchesArtifact(tool, bytes, crypto))
              ? "matching"
              : "different-unknown",
      };
    }),
  );
}

/**
 * Return a selected batch only after every fetched file has verified. No disk
 * writes or staging callbacks occur here. Caller must still confirm replacement
 * and commit the entire batch through its guarded disk-management session.
 */
export async function fetchToolUpdates(
  catalog,
  selectedIds,
  {
    expectedDistribution,
    baseUrl,
    fetch = globalThis.fetch,
    crypto = globalThis.crypto,
  } = {},
) {
  const checked = validateToolCatalog(catalog, expectedDistribution);
  requireValue(Array.isArray(selectedIds), "tool selection must be an array");
  const ids = [...selectedIds];
  requireValue(
    ids.length > 0 &&
      new Set(ids).size === ids.length &&
      ids.every((id) => checked.tools.some((tool) => tool.id === id)),
    "empty, duplicate or unknown tool selection",
  );
  const base = new URL(baseUrl);
  requireValue(
    ["https:", "http:"].includes(base.protocol),
    "asset base must be an HTTP(S) URL",
  );
  return Promise.all(
    ids.map(async (id) => {
      const tool = checked.tools.find((candidate) => candidate.id === id);
      const response = await fetch(new URL(tool.asset, base).href, {
        cache: "no-store",
        redirect: "error",
      });
      requireValue(response.ok, `${tool.name} download failed`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      requireValue(
        await matchesArtifact(tool, bytes, crypto),
        `${tool.name} artifact verification failed`,
      );
      return { name: tool.name, bytes };
    }),
  );
}
