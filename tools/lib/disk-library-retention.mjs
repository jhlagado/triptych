import { createHash } from "node:crypto";
import { validateDiskCatalogue } from "../../crates/triptych-host-wasm/web/disk-catalogue.js";

const SCHEMA = "triptych-disk-library-retention-v1";
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const MAX_ASSETS = 4096,
  MAX_JSON = 16 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024,
  MAX_IMAGE = 8388608;
const sizes = new Map([
  ["ibm3740", 256512],
  ["triptych-cpm-2m-v1", 2097152],
  ["triptych-cpm-8m-v1", MAX_IMAGE],
]);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (key, value) =>
  Reflect.apply(
    Object.getOwnPropertyDescriptor(typedPrototype, key).get,
    value,
    [],
  );
function check(condition, reason) {
  if (!condition) throw new Error(`Disk library retention: ${reason}.`);
}
function fields(value, names) {
  check(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid record",
  );
  check(
    Object.keys(value).sort().join(",") === names.split(",").sort().join(","),
    "unexpected fields",
  );
}
function list(value) {
  check(
    Array.isArray(value) && value.length <= MAX_ASSETS,
    "invalid collection size",
  );
  return value;
}
// Reject executable/non-JSON inputs without calling accessors or toJSON. Bound
// before JSON serialization; canonical equality ignores only object key order.
function capture(value, depth = 0, state = { budget: 0 }) {
  check(depth <= 64, "metadata nesting exceeds bound");
  state.budget += 32 + (typeof value === "string" ? value.length * 6 : 0);
  check(state.budget <= MAX_JSON, "metadata exceeds bound");
  if (value === null || ["string", "boolean"].includes(typeof value))
    return value;
  if (typeof value === "number") {
    check(
      Number.isFinite(value) && !Object.is(value, -0),
      "invalid JSON number",
    );
    return value;
  }
  check(value && typeof value === "object", "non-JSON metadata");
  const array = Array.isArray(value),
    proto = Object.getPrototypeOf(value);
  check(
    array || proto === Object.prototype || proto === null,
    "non-JSON object",
  );
  const keys = Reflect.ownKeys(value);
  if (array) {
    check(
      value.length <= MAX_ASSETS && keys.length === value.length + 1,
      "sparse or extended array",
    );
    return Array.from({ length: value.length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(value, String(index));
      check(
        field && "value" in field && field.enumerable,
        "accessor or sparse array",
      );
      return capture(field.value, depth + 1, state);
    });
  }
  check(
    keys.every((key) => typeof key === "string"),
    "symbol metadata",
  );
  return Object.fromEntries(
    keys.sort().map((key) => {
      state.budget += key.length * 6;
      const field = Object.getOwnPropertyDescriptor(value, key);
      check(
        "value" in field && field.enumerable,
        "accessor or hidden metadata",
      );
      return [key, capture(field.value, depth + 1, state)];
    }),
  );
}
const canonical = (value) => JSON.stringify(capture(value));
function unique(rows, key, label) {
  const result = new Map();
  for (const row of list(rows)) {
    const id = key(row);
    check(!result.has(id), `duplicate ${label}`);
    result.set(id, row);
  }
  return result;
}
function identity(value) {
  check(typeof value === "string" && ID.test(value), "invalid identity");
}
function flat(value) {
  check(
    typeof value === "string" && FLAT.test(value),
    "invalid flat asset name",
  );
}

/** Pure retention validation, not guest/runtime qualification. Admission JSON
 * is preserved exactly; bindings map its original flat asset paths onto retained
 * files, without rewriting source evidence or weakening runtime admission.
 * Returns owned metadata/bytes. No filesystem, network, writes or defaults guess.
 */
export function validateDiskLibraryRetention({
  manifest: input,
  assets: inputs,
}) {
  const manifest = capture(input);
  fields(manifest, "schema,assets,images,admissions,recipes,defaults");
  check(manifest.schema === SCHEMA, "unsupported schema");
  check(
    inputs instanceof Map && inputs.size <= MAX_ASSETS,
    "asset Map required",
  );
  const assetRows = unique(manifest.assets, (row) => row.path, "asset");
  const assets = new Map();
  let total = 0;
  for (const row of assetRows.values()) {
    fields(row, "path,bytes,sha256");
    flat(row.path);
    const addressed =
      /^([A-Za-z0-9][A-Za-z0-9._-]*)-([a-f0-9]{64})\.(bin|img|json)$/.exec(
        row.path,
      );
    check(
      HASH.test(row.sha256) && addressed?.[2] === row.sha256,
      "asset name must end in its content hash and supported extension",
    );
    check(
      Number.isSafeInteger(row.bytes) &&
        row.bytes >= 0 &&
        row.bytes <= MAX_JSON,
      "asset size exceeds bound",
    );
    total += row.bytes;
    check(total <= MAX_TOTAL, "retained assets exceed bound");
    const source = inputs.get(row.path);
    check(
      source instanceof Uint8Array &&
        intrinsic("byteLength", source) === row.bytes,
      "missing or wrong-length asset",
    );
    const bytes = new Uint8Array(
      intrinsic("buffer", source),
      intrinsic("byteOffset", source),
      row.bytes,
    ).slice();
    check(hash(bytes) === row.sha256, "asset hash differs");
    assets.set(row.path, bytes);
  }
  check(inputs.size === assets.size, "unlisted asset payload");
  function asset(path, expectedLength, expectedHash) {
    flat(path);
    const row = assetRows.get(path);
    check(row, `missing asset ${path}`);
    if (expectedLength !== undefined)
      check(row.bytes === expectedLength, "reference length differs");
    if (expectedHash !== undefined)
      check(row.sha256 === expectedHash, "reference hash differs");
    return row;
  }
  function json(path) {
    asset(path);
    check(path.endsWith(".json"), "JSON asset extension required");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      assets.get(path),
    );
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      check(false, "invalid retained JSON");
    }
    // Whitespace is allowed, but duplicate object fields are not.
    const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) =>
      token.startsWith('"') ? token : "",
    );
    check(JSON.stringify(parsed) === compact, "noncanonical retained JSON");
    return capture(parsed);
  }
  const catalogue = validateDiskCatalogue({
    schema: "triptych-disk-catalogue-v1",
    images: manifest.images,
  });
  const images = unique(
    catalogue.images,
    (image) => `${image.id}:${image.revision}`,
    "image identity",
  );
  for (const image of images.values())
    asset(image.asset, image.byteLength, image.sha256);
  const admissions = unique(
    manifest.admissions,
    (entry) => entry.id,
    "admission identity",
  );
  const evidence = new Map();
  for (const entry of admissions.values()) {
    fields(entry, "id,envelope,bindings");
    identity(entry.id);
    const envelope = json(entry.envelope);
    check(
      envelope.schema === "triptych-browser-deployment-v1",
      "invalid admission envelope schema",
    );
    const bindings = unique(
      entry.bindings,
      (binding) => binding.path,
      "admission binding",
    );
    for (const binding of bindings.values()) {
      fields(binding, "path,asset");
      flat(binding.path);
      asset(binding.asset);
    }
    const rows = unique(envelope.assets, (row) => row.path, "admission asset");
    check(rows.size === bindings.size, "incomplete admission bindings");
    for (const row of rows.values()) {
      fields(row, "path,bytes,sha256");
      flat(row.path);
      check(bindings.has(row.path), "missing admission binding");
      asset(bindings.get(row.path).asset, row.bytes, row.sha256);
    }
    const profiles = unique(
      envelope.twoMibProfiles,
      (profile) => profile.configuredCount,
      "admission drive count",
    );
    check(
      profiles.size > 0 && profiles.size <= 16,
      "invalid admission profile count",
    );
    for (const profile of profiles.values()) {
      check(
        Number.isInteger(profile.configuredCount) &&
          profile.configuredCount >= 1 &&
          profile.configuredCount <= 16,
        "invalid configured count",
      );
      check(
        profile.residentProfile ===
          `triptych-cpu-v0.1-2m-n${String(profile.configuredCount).padStart(2, "0")}`,
        "profile identity differs",
      );
      for (const [kind, length] of [
        ["bootstrap", 256],
        ["system", 16384],
      ]) {
        const ref = profile[kind];
        check(ref && bindings.has(ref.asset), "missing profile asset binding");
        check(
          ref.bytes === length && HASH.test(ref.sha256),
          "invalid profile asset",
        );
        asset(bindings.get(ref.asset).asset, length, ref.sha256);
      }
    }
    evidence.set(entry.id, { profiles, bindings });
  }
  const recipes = unique(
    manifest.recipes,
    (recipe) => `${recipe.id}:${recipe.revision}`,
    "recipe identity",
  );
  for (const recipe of recipes.values()) {
    fields(
      recipe,
      "id,revision,name,configuredCount,admission,bootstrap,slots,provenance",
    );
    identity(recipe.id);
    identity(recipe.revision);
    check(
      typeof recipe.name === "string" &&
        recipe.name.trim().length > 0 &&
        recipe.name.length <= 255,
      "invalid recipe name",
    );
    identity(recipe.admission);
    const admitted = evidence.get(recipe.admission),
      profile = admitted?.profiles.get(recipe.configuredCount);
    check(profile, "missing recipe admission profile");
    asset(recipe.bootstrap, 256, profile.bootstrap.sha256);
    json(recipe.provenance);
    check(
      Array.isArray(recipe.slots) &&
        recipe.slots.length === recipe.configuredCount,
      "recipe slot count differs",
    );
    const roles = new Set();
    for (const [index, slot] of recipe.slots.entries()) {
      if (slot === null) {
        check(index !== 0, "A needs a system image");
        continue;
      }
      if (slot.kind === "published") {
        fields(slot, "kind,image");
        fields(slot.image, "id,revision");
        identity(slot.image.id);
        identity(slot.image.revision);
        const image = images.get(`${slot.image.id}:${slot.image.revision}`);
        check(
          image && image.geometry === "triptych-cpm-2m-v1",
          "missing or incompatible recipe image",
        );
        if (index === 0) {
          check(
            image.systemProfile === profile.residentProfile,
            "A profile differs",
          );
          check(
            hash(assets.get(image.asset).subarray(0, 16384)) ===
              profile.system.sha256,
            "A system differs from admission",
          );
        }
      } else {
        fields(slot, "kind,role,name,geometry,seed");
        fields(slot.seed, "asset,systemProfile");
        check(
          slot.kind === "writable-role" &&
            typeof slot.role === "string" &&
            /^[a-z][a-z0-9-]{0,63}$/.test(slot.role) &&
            !roles.has(slot.role),
          "invalid or duplicate writable role",
        );
        roles.add(slot.role);
        check(
          typeof slot.name === "string" &&
            slot.name.trim().length > 0 &&
            slot.name.length <= 255,
          "invalid role name",
        );
        check(
          slot.geometry === "triptych-cpm-2m-v1" &&
            slot.seed.systemProfile === null &&
            index !== 0,
          "unsupported seed profile",
        );
        asset(slot.seed.asset, sizes.get(slot.geometry));
      }
    }
  }
  const defaults = unique(
    manifest.defaults,
    (entry) => entry.id,
    "default identity",
  );
  for (const entry of defaults.values()) {
    fields(entry, "id,revision");
    identity(entry.id);
    identity(entry.revision);
    check(
      recipes.has(`${entry.id}:${entry.revision}`),
      "default recipe is missing",
    );
  }
  return { manifest, assets };
}

/** Incoming is a self-contained candidate release. Existing identities are
 * immutable; omission never removes history. Defaults change only via options.
 */
export function mergeDiskLibraryRetention(
  previous,
  incoming,
  { defaults } = {},
) {
  const before = validateDiskLibraryRetention(previous),
    next = validateDiskLibraryRetention(incoming);
  const manifest = { schema: SCHEMA },
    assets = new Map(before.assets);
  for (const [collection, key] of [
    ["assets", (row) => row.path],
    ["images", (row) => `${row.id}:${row.revision}`],
    ["admissions", (row) => row.id],
    ["recipes", (row) => `${row.id}:${row.revision}`],
  ]) {
    const merged = new Map(
      before.manifest[collection].map((row) => [key(row), row]),
    );
    for (const row of next.manifest[collection]) {
      const existing = merged.get(key(row));
      check(
        !existing || canonical(existing) === canonical(row),
        `immutable ${collection} identity changed`,
      );
      if (!existing) merged.set(key(row), row);
    }
    manifest[collection] = [...merged.values()];
  }
  for (const [path, bytes] of next.assets) {
    if (!assets.has(path)) assets.set(path, bytes);
  }
  manifest.defaults =
    defaults === undefined ? before.manifest.defaults : defaults;
  return validateDiskLibraryRetention({ manifest, assets });
}
