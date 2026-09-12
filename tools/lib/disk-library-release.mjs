import { createHash } from "node:crypto";
import { validateDiskCatalogue } from "../../crates/triptych-host-wasm/web/disk-catalogue.js";
import { validateDiskLibraryRetention } from "./disk-library-retention.mjs";

const MAX_BYTES = 16 * 1024 * 1024;
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const intrinsic = (key, value) =>
  Reflect.apply(
    Object.getOwnPropertyDescriptor(typedPrototype, key).get,
    value,
    [],
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function check(condition, message) {
  if (!condition) throw new Error(`Disk library release: ${message}.`);
}
function view(source) {
  check(source instanceof Uint8Array, "byte payload required");
  const length = intrinsic("byteLength", source);
  check(length <= MAX_BYTES, "payload exceeds bound");
  return new Uint8Array(
    intrinsic("buffer", source),
    intrinsic("byteOffset", source),
    length,
  );
}
const own = (source) => view(source).slice();
function parse(bytes) {
  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    value = JSON.parse(text);
    const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) =>
      token.startsWith('"') ? token : "",
    );
    check(
      JSON.stringify(value) === compact,
      "noncanonical or duplicate JSON fields",
    );
  } catch (error) {
    throw new Error(`Disk library release: invalid JSON: ${error.message}`);
  }
  return value;
}
function sorted(value, depth = 0, budget = { bytes: 0 }) {
  check(depth <= 64, "metadata nesting exceeds bound");
  budget.bytes += 32 + (typeof value === "string" ? value.length * 6 : 0);
  check(budget.bytes <= MAX_BYTES, "metadata exceeds bound");
  if (Array.isArray(value))
    return value.map((item) => sorted(item, depth + 1, budget));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => {
          budget.bytes += key.length * 6;
          return [key, sorted(value[key], depth + 1, budget)];
        }),
    );
  return value;
}
const canonical = (value) => JSON.stringify(sorted(value));

/** Capture an already qualified N4 build; never assemble, fetch, pin or write.
 * All metadata inputs are the exact JSON bytes intended for publication. The
 * admission envelope is a qualified one-profile subset with its original logical
 * asset names; assets maps those names and catalogue image names to owned bytes.
 * blankSeed is the verified CpmDisk.create_two_mib().export_source() payload.
 * Full machine/source qualification remains the caller's build responsibility.
 */
export function captureDiskLibraryRelease({
  catalogueBytes: sourceCatalogue,
  provenanceBytes: sourceProvenance,
  admissionBytes: sourceAdmission,
  assets: sources,
  blankSeed: sourceSeed,
}) {
  check(sources instanceof Map && sources.size <= 4096, "asset Map required");
  const catalogueBytes = own(sourceCatalogue),
    provenanceBytes = own(sourceProvenance),
    admissionBytes = own(sourceAdmission),
    seed = own(sourceSeed);
  const catalogue = validateDiskCatalogue(parse(catalogueBytes)),
    provenance = parse(provenanceBytes),
    envelope = parse(admissionBytes);
  check(
    envelope?.schema === "triptych-browser-deployment-v1" &&
      Array.isArray(envelope.twoMibProfiles) &&
      envelope.twoMibProfiles.length === 1,
    "one-profile admission envelope required",
  );
  const profile = envelope.twoMibProfiles[0];
  check(
    profile?.configuredCount === 4 &&
      profile.residentProfile === "triptych-cpu-v0.1-2m-n04",
    "qualified N4 profile required",
  );
  check(
    provenance?.schema === "triptych-disk-library-provenance-v1" &&
      canonical(provenance.system) === canonical(profile),
    "provenance system differs from admission",
  );
  const systemImage = published("system-2m-n04"),
    gamesImage = published("games-2m");
  check(
    Array.isArray(provenance.images) &&
      provenance.images.length === catalogue.images.length,
    "provenance image coverage differs",
  );
  const provenanceImages = new Map();
  for (const image of provenance.images) {
    check(
      image &&
        typeof image.asset === "string" &&
        !provenanceImages.has(image.asset),
      "duplicate or invalid provenance image",
    );
    provenanceImages.set(image.asset, image);
  }
  for (const image of catalogue.images) {
    const proof = provenanceImages.get(image.asset);
    check(
      proof &&
        proof.bytes === image.byteLength &&
        proof.sha256 === image.sha256 &&
        (!Object.hasOwn(proof, "systemProfile") ||
          proof.systemProfile === image.systemProfile),
      "provenance image identity differs",
    );
    provenanceImages.delete(image.asset);
  }
  check(provenanceImages.size === 0, "extra provenance image");
  check(
    seed.length === 2097152 &&
      seed.subarray(0, 16384).every((byte) => byte === 0),
    "two-MiB data seed required",
  );
  const manifest = {
      schema: "triptych-disk-library-retention-v1",
      assets: [],
      images: catalogue.images,
      admissions: [],
      recipes: [],
      defaults: [],
    },
    assets = new Map(),
    planned = new Map();
  let total = 0;
  function plan(path, bytes, sha256, payload) {
    check(
      typeof sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(sha256) &&
        Number.isSafeInteger(bytes) &&
        bytes >= 0 &&
        bytes <= MAX_BYTES,
      "invalid planned asset size or hash",
    );
    const existing = planned.get(path);
    if (existing) {
      check(
        existing.bytes === bytes && existing.sha256 === sha256,
        "asset collision",
      );
      existing.payloads.push(payload);
    } else {
      total += bytes;
      check(total <= 1024 * 1024 * 1024, "aggregate byte bound exceeded");
      check(planned.size < 4096, "asset count exceeds bound");
      planned.set(path, { bytes, sha256, payloads: [payload] });
      manifest.assets.push({ path, bytes, sha256 });
    }
    return path;
  }
  function add(prefix, bytes, extension, exactPath) {
    const sha256 = hash(bytes),
      path = exactPath ?? `${prefix}-${sha256}.${extension}`;
    return plan(path, bytes.length, sha256, bytes);
  }
  // Preserve published image row filenames and the actual catalogue/provenance
  // bytes. Mutable hosting aliases are deliberately absent from this package.
  add("library-catalogue", catalogueBytes, "json");
  const provenanceAsset = add("library-provenance", provenanceBytes, "json");
  const admissionAsset = add("library-admission", admissionBytes, "json");
  for (const image of catalogue.images) {
    check(
      image.revision === image.sha256,
      "image revision must equal its byte hash",
    );
    plan(image.asset, image.byteLength, image.sha256, image.asset);
  }
  check(
    Array.isArray(envelope.assets) && envelope.assets.length <= 4096,
    "invalid admission assets",
  );
  const bindings = envelope.assets.map((row) => {
    check(
      row &&
        typeof row.path === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(row.path),
      "invalid logical asset path",
    );
    const extension = row.path.split(".").at(-1);
    check(
      ["bin", "img", "json"].includes(extension),
      "unsupported retained asset extension",
    );
    return {
      path: row.path,
      asset: plan(
        `library-retained-${row.sha256}.${extension}`,
        row.bytes,
        row.sha256,
        row.path,
      ),
    };
  });
  const admissionId = hash(admissionBytes);
  manifest.admissions.push({
    id: admissionId,
    envelope: admissionAsset,
    bindings,
  });
  const bootstrap = bindings.find(
    (row) => row.path === profile.bootstrap?.asset,
  )?.asset;
  check(bootstrap, "bootstrap binding required");
  const seedAsset = add("library-seed", seed, "img");
  function published(id) {
    const candidates = catalogue.images.filter((image) => image.id === id);
    check(candidates.length === 1, `exactly one current ${id} image required`);
    const image = candidates[0];
    return {
      kind: "published",
      image: { id: image.id, revision: image.revision },
    };
  }
  const role = (name) => ({
    kind: "writable-role",
    role: name,
    name: name === "work" ? "Work" : "Saves",
    geometry: "triptych-cpm-2m-v1",
    seed: { asset: seedAsset, systemProfile: null },
  });
  const templates = [false, true].map((libraryOnly) => ({
    id: libraryOnly ? "library" : "starter",
    name: libraryOnly
      ? "Protected library only"
      : "Tools, games and personal disks",
    configuredCount: 4,
    admission: admissionId,
    bootstrap,
    slots: [
      systemImage,
      libraryOnly ? null : role("work"),
      gamesImage,
      libraryOnly ? null : role("saves"),
    ],
    provenance: provenanceAsset,
  }));
  if (catalogue.images.some((image) => image.id === "colossal-cave-350"))
    templates.push({
      id: "colossal-cave-350",
      name: "Colossal Cave with personal save disk",
      configuredCount: 4,
      admission: admissionId,
      bootstrap,
      slots: [systemImage, role("work"), published("colossal-cave-350"), null],
      provenance: provenanceAsset,
    });
  for (const template of templates) {
    // The revision covers the entire origin-independent template, excluding
    // only revision itself. Object keys sort recursively; array order is kept.
    const revision = hash(Buffer.from(canonical(template)));
    manifest.recipes.push({ ...template, revision });
    manifest.defaults.push({ id: template.id, revision });
  }
  // Check complete prospective metadata before touching bulk inputs. Account
  // for unique output filenames, including evidence and shared seed assets.
  canonical(manifest);
  for (const [path, row] of planned) {
    // One output may represent several logical inputs. Every supplied alias
    // still needs validation; deduplication never excuses a missing source.
    for (const payload of row.payloads) {
      const bytes =
        typeof payload === "string" ? view(sources.get(payload)) : payload;
      check(
        bytes.length === row.bytes && hash(bytes) === row.sha256,
        "planned asset differs",
      );
      if (!assets.has(path)) assets.set(path, bytes);
    }
  }
  // The retention validator performs the sole ownership copy of bulk images;
  // staging views avoids holding a second full copied candidate concurrently.
  return validateDiskLibraryRetention({ manifest, assets });
}
