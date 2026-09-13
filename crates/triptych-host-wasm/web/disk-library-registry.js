import {
  validateDiskCatalogue,
  publishedImageReference,
  fetchPublishedImage,
} from "./disk-catalogue.js";
import {
  canonicalLaunchRecipeDescriptor,
  launchRecipeDigest,
} from "./disk-launch.js";
import { validateTwoMibDeployment } from "./two-mib-system.js";

const HASH = /^[a-f0-9]{64}$/,
  ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX = 16 * 1024 * 1024,
  COUNT = 4096;
const handles = new WeakMap(),
  encoder = new TextEncoder();
const check = (value, message) => {
  if (!value) throw new Error(`Disk library registry: ${message}`);
};
const identity = (value) =>
  check(typeof value === "string" && ID.test(value), "invalid identity");
const flat = (value) =>
  check(typeof value === "string" && FLAT.test(value), "invalid flat asset");
const sha = async (bytes, crypto) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
function fields(value, names) {
  check(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      JSON.stringify(Object.keys(value).sort()) ===
        JSON.stringify(names.split(",").sort()),
    "unexpected fields",
  );
}
function capture(value, depth = 0, budget = { bytes: 0 }) {
  check(depth <= 64, "metadata nesting exceeds bound");
  budget.bytes += 32 + (typeof value === "string" ? value.length * 6 : 0);
  check(budget.bytes <= MAX, "metadata exceeds bound");
  if (value === null || ["string", "boolean"].includes(typeof value))
    return value;
  if (typeof value === "number") {
    check(Number.isFinite(value) && !Object.is(value, -0), "invalid number");
    return value;
  }
  check(value && typeof value === "object", "non-JSON value");
  const array = Array.isArray(value),
    keys = Reflect.ownKeys(value);
  check(
    array || [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "non-JSON object",
  );
  if (array)
    check(
      value.length <= COUNT && keys.length === value.length + 1,
      "sparse or extended array",
    );
  const names = array
    ? Array.from({ length: value.length }, (_, i) => String(i))
    : keys.sort();
  const entries = names.map((key) => {
    check(typeof key === "string", "symbol property");
    budget.bytes += key.length * 6;
    const property = Object.getOwnPropertyDescriptor(value, key);
    check(
      property && "value" in property && property.enumerable,
      "accessor or hidden property",
    );
    return [key, capture(property.value, depth + 1, budget)];
  });
  return array ? entries.map(([, v]) => v) : Object.fromEntries(entries);
}
function freeze(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function unique(rows, key) {
  check(Array.isArray(rows) && rows.length <= COUNT, "invalid collection");
  const map = new Map();
  for (const row of rows) {
    const id = key(row);
    check(!map.has(id), "duplicate identity");
    map.set(id, row);
  }
  return map;
}
function parse(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    value = JSON.parse(text);
  const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) =>
    token.startsWith('"') ? token : "",
  );
  check(
    JSON.stringify(value) === compact,
    "duplicate or noncanonical JSON fields",
  );
  return capture(value);
}
function urlAt(path, base) {
  flat(path);
  return new URL(path, base).href;
}
async function bytesAt(url, { fetch, crypto }, reference) {
  const response = await fetch(url, { cache: "no-store", redirect: "error" });
  let reader;
  try {
    check(
      response?.ok &&
        !response.redirected &&
        (!response.url || response.url === url),
      "missing or redirected asset",
    );
    const raw = response.headers.get("content-length"),
      encoding = response.headers.get("content-encoding")?.trim().toLowerCase(),
      decodedLengthHeader =
        raw !== null && (!encoding || encoding === "identity"),
      expected = reference?.bytes;
    check(
      raw === null ||
        (/^(0|[1-9]\d*)$/.test(raw) &&
          Number(raw) <= MAX &&
          (!decodedLengthHeader ||
            expected === undefined ||
            Number(raw) === expected)),
      "content length exceeds bound or differs",
    );
    check(response.body?.getReader, "streaming body required");
    reader = response.body.getReader();
    const chunks = [];
    let count = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      check(
        value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
        "invalid chunk",
      );
      check(value.length <= (expected ?? MAX) - count, "stream exceeds bound");
      if (value.length === 0) continue;
      chunks.push(
        new Uint8Array(
          value.buffer,
          value.byteOffset,
          value.byteLength,
        ).slice(),
      );
      count += value.length;
    }
    check(
      (expected === undefined || count === expected) &&
        (!decodedLengthHeader || count === Number(raw)),
      "body length differs",
    );
    const result = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    if (reference)
      check(
        (await sha(result, crypto)) === reference.sha256,
        "asset hash differs",
      );
    return result;
  } catch (error) {
    try {
      Promise.resolve(reader ? reader.cancel() : response.body?.cancel()).catch(
        () => {},
      );
    } catch {}
    throw error;
  } finally {
    reader?.releaseLock();
  }
}

/** Bounded metadata-only discovery. baseUrl is the app directory (defaults to
 * the current browser page); arbitrary origins and nested registry paths reject.
 * No bootstrap, seed or disk image is fetched by discovery or resolution.
 */
export async function loadDiskLibraryRegistry({
  baseUrl = globalThis.location?.href,
  url = "disk-library-registry.json",
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
} = {}) {
  const base = new URL(baseUrl);
  check(
    ["https:", "http:"].includes(base.protocol) &&
      !base.username &&
      !base.password,
    "invalid app origin",
  );
  const directory = new URL(".", base),
    target = new URL(url, directory);
  check(
    target.origin === directory.origin &&
      !target.search &&
      !target.hash &&
      !target.username &&
      !target.password &&
      new URL(".", target).href === directory.href,
    "registry outside app directory",
  );
  flat(target.pathname.slice(directory.pathname.length));
  const deps = { fetch, crypto },
    manifest = parse(await bytesAt(target.href, deps));
  fields(manifest, "schema,assets,images,admissions,recipes,defaults");
  check(
    manifest.schema === "triptych-disk-library-retention-v1",
    "unsupported schema",
  );
  const assets = unique(manifest.assets, (row) => row.path);
  let total = 0;
  for (const row of assets.values()) {
    fields(row, "path,bytes,sha256");
    flat(row.path);
    check(
      typeof row.sha256 === "string" &&
        HASH.test(row.sha256) &&
        row.path.endsWith(`-${row.sha256}.${row.path.split(".").at(-1)}`) &&
        /\.(bin|img|json)$/.test(row.path),
      "asset is not content addressed",
    );
    check(
      Number.isSafeInteger(row.bytes) && row.bytes >= 0 && row.bytes <= MAX,
      "asset size exceeds bound",
    );
    total += row.bytes;
    check(total <= 1024 * 1024 * 1024, "registry exceeds total bound");
  }
  const asset = (path, length, hash) => {
    flat(path);
    const row = assets.get(path);
    check(
      row &&
        (length === undefined || row.bytes === length) &&
        (hash === undefined || row.sha256 === hash),
      "missing or mismatched asset reference",
    );
    return row;
  };
  const catalogue = validateDiskCatalogue({
    schema: "triptych-disk-catalogue-v1",
    images: manifest.images,
  });
  const images = new Map(
    catalogue.images.map((row) => [`${row.id}:${row.revision}`, row]),
  );
  for (const image of images.values()) {
    check(
      image.revision === image.sha256,
      "image revision must pin its body hash",
    );
    asset(image.asset, image.byteLength, image.sha256);
  }
  const admissions = unique(manifest.admissions, (row) => row.id);
  for (const row of admissions.values()) {
    fields(row, "id,envelope,bindings");
    identity(row.id);
    check(
      asset(row.envelope).sha256 === row.id,
      "admission identity must pin its envelope hash",
    );
    check(row.envelope.endsWith(".json"), "admission must be JSON");
    for (const binding of unique(row.bindings, (row) => row.path).values()) {
      fields(binding, "path,asset");
      flat(binding.path);
      asset(binding.asset);
    }
  }
  const recipes = unique(
    manifest.recipes,
    (row) => `${row.id}:${row.revision}`,
  );
  for (const row of recipes.values()) {
    fields(
      row,
      "id,revision,name,configuredCount,admission,bootstrap,slots,provenance",
    );
    identity(row.id);
    identity(row.revision);
    identity(row.admission);
    const { revision, ...portable } = row;
    check(
      HASH.test(revision) &&
        (await sha(
          encoder.encode(JSON.stringify(capture(portable))),
          crypto,
        )) === revision,
      "portable recipe revision differs",
    );
    check(admissions.has(row.admission), "missing admission");
    asset(row.bootstrap, 256);
    asset(row.provenance);
    check(row.provenance.endsWith(".json"), "provenance must be JSON");
    check(
      Number.isInteger(row.configuredCount) &&
        row.configuredCount >= 1 &&
        row.configuredCount <= 16 &&
        Array.isArray(row.slots) &&
        row.slots.length === row.configuredCount,
      "invalid slot count",
    );
    const profile = `triptych-cpu-v0.1-2m-n${String(row.configuredCount).padStart(2, "0")}`;
    const slots = row.slots.map((slot, index) => {
      if (slot === null) {
        check(index !== 0, "A requires a system disk");
        return null;
      }
      if (slot.kind === "published") {
        fields(slot, "kind,image");
        fields(slot.image, "id,revision");
        identity(slot.image.id);
        identity(slot.image.revision);
        const image = images.get(`${slot.image.id}:${slot.image.revision}`);
        check(
          image &&
            image.geometry === "triptych-cpm-2m-v1" &&
            (index !== 0 || image.systemProfile === profile),
          "missing or incompatible published image",
        );
        return {
          kind: "published",
          image: publishedImageReference(
            catalogue,
            image.id,
            image.revision,
            directory.href,
          ),
        };
      }
      fields(slot, "kind,role,name,geometry,seed");
      fields(slot.seed, "asset,systemProfile");
      check(
        slot.kind === "writable-role" &&
          index !== 0 &&
          slot.geometry === "triptych-cpm-2m-v1" &&
          slot.seed.systemProfile === null,
        "invalid writable role",
      );
      const seed = asset(slot.seed.asset, 2097152);
      return {
        kind: slot.kind,
        role: slot.role,
        name: slot.name,
        geometry: slot.geometry,
        seed: {
          sha256: seed.sha256,
          byteLength: seed.bytes,
          systemProfile: null,
        },
      };
    });
    canonicalLaunchRecipeDescriptor({
      schema: "triptych-launch-recipe-v1",
      id: row.id,
      revision,
      name: row.name,
      configuredCount: row.configuredCount,
      bootstrap: {
        profile,
        sha256: asset(row.bootstrap).sha256,
        byteLength: 256,
      },
      slots,
    });
  }
  for (const row of unique(manifest.defaults, (row) => row.id).values()) {
    fields(row, "id,revision");
    identity(row.id);
    identity(row.revision);
    check(recipes.has(`${row.id}:${row.revision}`), "missing default recipe");
  }
  const handle = freeze({ url: target.href, metadata: manifest });
  handles.set(handle, {
    manifest,
    catalogue,
    recipes,
    admissions,
    images,
    asset,
    directory: directory.href,
    deps,
  });
  return handle;
}

/** Exact lookup, or an explicit {default:id}. Unknown revisions never fallback.
 * Returned admission JSON bytes are unmodified. assetBindings translate only
 * admitted logical names to retained hash-addressed assets.
 */
export async function resolveDiskLibraryRecipe(registry, selection) {
  const state = handles.get(registry);
  check(state, "unknown registry handle");
  const query = capture(selection);
  let reference;
  if (Object.hasOwn(query, "default")) {
    fields(query, "default");
    identity(query.default);
    reference = state.manifest.defaults.find((row) => row.id === query.default);
  } else {
    fields(query, "id,revision");
    identity(query.id);
    identity(query.revision);
    reference = query;
  }
  const row =
    reference && state.recipes.get(`${reference.id}:${reference.revision}`);
  check(row, "unknown recipe revision/default");
  const admitted = state.admissions.get(row.admission),
    envelopeRef = state.asset(admitted.envelope);
  const admissionBytes = await bytesAt(
    urlAt(admitted.envelope, state.directory),
    state.deps,
    envelopeRef,
  );
  const admission = parse(admissionBytes);
  check(
    admission.schema === "triptych-browser-deployment-v1",
    "invalid admission schema",
  );
  const profile = validateTwoMibDeployment(admission, row.configuredCount);
  check(profile, "missing admitted profile");
  const bindings = unique(admitted.bindings, (row) => row.path),
    envelopeAssets = unique(admission.assets, (row) => row.path);
  check(bindings.size === envelopeAssets.size, "incomplete admission bindings");
  const assetBindings = {};
  for (const expected of envelopeAssets.values()) {
    fields(expected, "path,bytes,sha256");
    flat(expected.path);
    const binding = bindings.get(expected.path);
    check(binding, "missing admission binding");
    const asset = state.asset(binding.asset, expected.bytes, expected.sha256);
    Object.defineProperty(assetBindings, expected.path, {
      value: {
        url: urlAt(asset.path, state.directory),
        sha256: asset.sha256,
        byteLength: asset.bytes,
      },
      enumerable: true,
    });
  }
  state.asset(row.bootstrap, 256, profile.bootstrap.sha256);
  const provenanceBytes = await bytesAt(
    urlAt(row.provenance, state.directory),
    state.deps,
    state.asset(row.provenance),
  );
  const provenance = parse(provenanceBytes);
  const descriptor = freeze(
    canonicalLaunchRecipeDescriptor({
      schema: "triptych-launch-recipe-v1",
      id: row.id,
      revision: row.revision,
      name: row.name,
      configuredCount: row.configuredCount,
      bootstrap: {
        profile: profile.residentProfile,
        sha256: profile.bootstrap.sha256,
        byteLength: 256,
      },
      slots: row.slots.map((slot) =>
        slot === null
          ? null
          : slot.kind === "published"
            ? {
                kind: "published",
                image: publishedImageReference(
                  state.catalogue,
                  slot.image.id,
                  slot.image.revision,
                  state.directory,
                ),
              }
            : {
                kind: "writable-role",
                role: slot.role,
                name: slot.name,
                geometry: slot.geometry,
                seed: {
                  sha256: state.asset(slot.seed.asset).sha256,
                  byteLength: 2097152,
                  systemProfile: null,
                },
              },
      ),
    }),
  );
  const digest = await launchRecipeDigest(descriptor, state.deps);
  return Object.freeze({
    reference: freeze({ id: row.id, revision: row.revision }),
    descriptor,
    digest,
    admission: freeze(admission),
    admissionId: admitted.id,
    admissionBytes: admissionBytes.slice(),
    assetBindings: freeze(assetBindings),
    provenance: freeze(provenance),
    async materialize() {
      const bootstrapBytes = await bytesAt(
        urlAt(row.bootstrap, state.directory),
        state.deps,
        state.asset(row.bootstrap),
      );
      const seedBytes = new Map();
      for (const slot of row.slots.filter(
        (slot) => slot?.kind === "writable-role",
      )) {
        const seed = state.asset(slot.seed.asset);
        seedBytes.set(
          slot.role,
          await fetchPublishedImage(
            {
              id: row.id,
              revision: seed.sha256,
              name: slot.name,
              geometry: slot.geometry,
              byteLength: seed.bytes,
              sha256: seed.sha256,
              url: urlAt(seed.path, state.directory),
              source: new URL(".", state.directory).href,
              license: "Recipient-local seed; see retained provenance",
              systemProfile: null,
            },
            state.deps,
          ),
        );
      }
      return { descriptor, digest, bootstrapBytes, seedBytes };
    },
  });
}

/** Recovery lookup binds admission to the exact retained system-image identity,
 * not just a count or bootstrap that could be shared by different residents.
 * Ambiguous evidence requires an explicit recipe selection, never a guess.
 */
export async function resolveDiskLibraryAdmission(registry, value) {
  const state = handles.get(registry);
  check(state, "unknown registry handle");
  const query = capture(value);
  fields(query, "image,configuredCount,bootstrapSha256");
  fields(query.image, "id,revision,sha256");
  identity(query.image.id);
  identity(query.image.revision);
  check(
    typeof query.image.sha256 === "string" && HASH.test(query.image.sha256),
    "invalid image hash",
  );
  check(
    typeof query.bootstrapSha256 === "string" &&
      HASH.test(query.bootstrapSha256),
    "invalid bootstrap hash",
  );
  const matches = [...state.recipes.values()].filter(
    (row) =>
      row.configuredCount === query.configuredCount &&
      row.slots[0]?.kind === "published" &&
      row.slots[0].image.id === query.image.id &&
      row.slots[0].image.revision === query.image.revision &&
      state.manifest.images.find(
        (image) =>
          image.id === query.image.id &&
          image.revision === query.image.revision,
      )?.sha256 === query.image.sha256 &&
      state.asset(row.bootstrap).sha256 === query.bootstrapSha256,
  );
  check(
    matches.length > 0 &&
      new Set(matches.map((row) => row.admission)).size === 1,
    "missing or ambiguous retained admission",
  );
  return resolveDiskLibraryRecipe(registry, {
    id: matches[0].id,
    revision: matches[0].revision,
  });
}
