import { validatePublishedImageReference } from "./disk-catalogue.js";
import { validateDiskBoxManifest } from "./disk-box.js";

const encoder = new TextEncoder();
const HASH = /^[0-9a-f]{64}$/;
const SIZES = new Map([
  ["ibm3740", 256512],
  ["triptych-cpm-2m-v1", 2097152],
  ["triptych-cpm-8m-v1", 8388608],
]);
function requireValue(condition, message) {
  if (!condition) throw new Error(`Disk launch: ${message}.`);
}
function record(value, required, optional = []) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "invalid record",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(
    required.every((key) => Object.hasOwn(descriptors, key)) &&
      Reflect.ownKeys(descriptors).every(
        (key) =>
          typeof key === "string" &&
          [...required, ...optional].includes(key) &&
          Object.hasOwn(descriptors[key], "value"),
      ),
    "unsupported fields or accessors",
  );
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, item]) => [key, item.value]),
  );
}
function identity(value) {
  requireValue(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    "invalid public identity",
  );
  return value;
}
function name(value) {
  requireValue(
    typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 255 &&
      value.isWellFormed() &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      encoder.encode(value).length <= 255,
    "invalid name",
  );
  return value;
}
function hash(value) {
  requireValue(typeof value === "string" && HASH.test(value), "invalid hash");
  return value;
}
function geometry(profile, count) {
  if (profile === `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`)
    return "triptych-cpm-2m-v1";
  if (profile === "legacy-e400" && count === 1) return "ibm3740";
  if (
    (profile === "triptych-cpu-v0.1-8m-a" && count === 1) ||
    (profile === "triptych-cpu-v0.1-8m-ab" && count === 2)
  )
    return "triptych-cpm-8m-v1";
  throw new Error("Disk launch: profile and configured count disagree.");
}

/** Registry wire metadata. Byte payloads and local IDs never enter this descriptor.
 * A seed's systemProfile is null for data or the matched profile for a system
 * template. This declaration does not replace actual resident admission.
 */
export function canonicalLaunchRecipeDescriptor(value) {
  const input = record(
    value,
    ["schema", "id", "revision", "name", "bootstrap", "slots"],
    ["configuredCount"],
  );
  requireValue(
    input.schema === "triptych-launch-recipe-v1",
    "unsupported recipe schema",
  );
  const count = Object.hasOwn(input, "configuredCount")
    ? input.configuredCount
    : 4;
  requireValue(
    Number.isInteger(count) && count >= 1 && count <= 16,
    "invalid configured count",
  );
  const boot = record(input.bootstrap, ["profile", "sha256", "byteLength"]);
  requireValue(boot.byteLength === 256, "invalid bootstrap length");
  const format = geometry(boot.profile, count);
  requireValue(
    Array.isArray(input.slots) && input.slots.length === count,
    "invalid slots",
  );
  const entries = Object.getOwnPropertyDescriptors(input.slots);
  requireValue(
    Reflect.ownKeys(entries).length === count + 1,
    "sparse or extended slots",
  );
  const roles = new Set();
  const slots = Array.from({ length: count }, (_, i) => {
    requireValue(
      Object.hasOwn(entries, i) && Object.hasOwn(entries[i], "value"),
      "sparse slots or accessors",
    );
    const raw = entries[i].value;
    if (raw === null) return null;
    const kind = Object.getOwnPropertyDescriptor(raw, "kind");
    requireValue(kind && Object.hasOwn(kind, "value"), "missing slot kind");
    if (kind.value === "published") {
      const slot = record(raw, ["kind", "image"]);
      const image = validatePublishedImageReference(slot.image);
      requireValue(image.geometry === format, "published geometry differs");
      return { kind: "published", image };
    }
    const slot = record(raw, ["kind", "role", "name", "geometry", "seed"]);
    requireValue(
      slot.kind === "writable-role" &&
        typeof slot.role === "string" &&
        /^[a-z][a-z0-9-]{0,63}$/.test(slot.role) &&
        !roles.has(slot.role),
      "invalid or duplicate role",
    );
    roles.add(slot.role);
    requireValue(slot.geometry === format, "role geometry differs");
    const seed = record(slot.seed, ["sha256", "byteLength", "systemProfile"]);
    requireValue(
      seed.byteLength === SIZES.get(format) &&
        (seed.systemProfile === null || seed.systemProfile === boot.profile),
      "invalid seed geometry or system profile",
    );
    return {
      kind: "writable-role",
      role: slot.role,
      name: name(slot.name),
      geometry: format,
      seed: {
        sha256: hash(seed.sha256),
        byteLength: seed.byteLength,
        systemProfile: seed.systemProfile,
      },
    };
  });
  const system = slots[0];
  requireValue(
    system !== null &&
      (system.kind === "published"
        ? system.image.systemProfile
        : system.seed.systemProfile) === boot.profile,
    "A requires a compatible system disk binding",
  );
  const result = {
    schema: input.schema,
    id: identity(input.id),
    revision: identity(input.revision),
    name: name(input.name),
    configuredCount: count,
    bootstrap: {
      profile: boot.profile,
      sha256: hash(boot.sha256),
      byteLength: 256,
    },
    slots,
  };
  requireValue(
    encoder.encode(JSON.stringify(result)).length <= 131072,
    "recipe metadata exceeds bound",
  );
  return result;
}
async function digest(bytes, crypto) {
  requireValue(crypto?.subtle, "cryptography unavailable");
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function launchRecipeDigest(
  descriptor,
  { crypto = globalThis.crypto } = {},
) {
  return digest(
    encoder.encode(JSON.stringify(canonicalLaunchRecipeDescriptor(descriptor))),
    crypto,
  );
}
/** Public routing data only. The registry owns URL syntax and verification. */
export function publicLaunchRecipeReference(descriptor) {
  const value = canonicalLaunchRecipeDescriptor(descriptor);
  return { id: value.id, revision: value.revision };
}
function ownBytes(value, length) {
  requireValue(
    value instanceof Uint8Array &&
      value.buffer instanceof ArrayBuffer &&
      value.byteLength === length,
    "missing or wrong-size payload",
  );
  return new Uint8Array(value);
}

/** Produce one atomic store candidate. This function never fetches, persists or
 * activates a machine; callers preview and authorize activation separately.
 * Keep the returned candidate and operation ID together when retrying a commit.
 */
export async function prepareDiskLaunch(
  current,
  recipe,
  {
    freshInstance = false,
    crypto = globalThis.crypto,
    createId = () => crypto.randomUUID(),
  } = {},
) {
  requireValue(
    typeof freshInstance === "boolean",
    "freshInstance must be boolean",
  );
  const manifest = validateDiskBoxManifest(current);
  const input = record(
    recipe,
    ["descriptor", "digest"],
    ["bootstrapBytes", "seedBytes"],
  );
  const descriptor = canonicalLaunchRecipeDescriptor(input.descriptor),
    expectedDigest = hash(input.digest);
  const selection = manifest.recipeSelections.find(
    (item) => item.recipeDigest === expectedDigest,
  );
  const reuse = !freshInstance && selection !== undefined;
  let bootstrap, seeds;
  if (!reuse) {
    bootstrap = ownBytes(input.bootstrapBytes, 256);
    const roles = descriptor.slots.filter(
      (slot) => slot?.kind === "writable-role",
    );
    requireValue(
      roles.length === 0 || input.seedBytes instanceof Map,
      "missing seed map",
    );
    seeds = new Map(
      roles.map((slot) => [
        slot.role,
        ownBytes(
          Map.prototype.get.call(input.seedBytes, slot.role),
          slot.seed.byteLength,
        ),
      ]),
    );
  }
  requireValue(
    (await digest(encoder.encode(JSON.stringify(descriptor)), crypto)) ===
      expectedDigest,
    "recipe digest mismatch",
  );
  if (reuse) {
    const instance = manifest.launchInstances.find(
      (item) => item.id === selection.instanceId,
    );
    manifest.selectedConfigurationId = instance.configurationId;
    return {
      manifest: validateDiskBoxManifest(manifest),
      newBlobs: new Map(),
      configurationId: instance.configurationId,
      reused: true,
    };
  }
  requireValue(
    (await digest(bootstrap, crypto)) === descriptor.bootstrap.sha256,
    "bootstrap hash mismatch",
  );
  const newBlobs = new Map();
  for (const slot of descriptor.slots) {
    if (slot?.kind !== "writable-role") continue;
    const bytes = seeds.get(slot.role);
    requireValue(
      (await digest(bytes, crypto)) === slot.seed.sha256,
      "seed hash mismatch",
    );
    const prior = newBlobs.get(slot.seed.sha256);
    requireValue(
      !prior ||
        (prior.length === bytes.length &&
          prior.every((byte, i) => byte === bytes[i])),
      "seed hash collision",
    );
    if (!prior) newBlobs.set(slot.seed.sha256, bytes);
  }
  const configurationId = createId(),
    instanceId = createId(),
    roles = [];
  const slots = descriptor.slots.map((slot) => {
    if (slot === null) return null;
    if (slot.kind === "published") return slot;
    const diskId = createId();
    manifest.personalDisks.push({
      id: diskId,
      name: slot.name,
      geometry: slot.geometry,
      content: { sha256: slot.seed.sha256, byteLength: slot.seed.byteLength },
    });
    roles.push({ role: slot.role, diskId });
    return { kind: "personal", diskId, writable: true };
  });
  manifest.configurations.push({
    id: configurationId,
    name: descriptor.name,
    configuredCount: descriptor.configuredCount,
    bootstrap: {
      profile: descriptor.bootstrap.profile,
      bytes: Array.from(bootstrap),
    },
    systemDisk: slots[0],
    slots,
  });
  manifest.launchInstances.push({
    id: instanceId,
    recipeDigest: expectedDigest,
    configurationId,
    roles,
  });
  manifest.recipeSelections = manifest.recipeSelections.filter(
    (item) => item.recipeDigest !== expectedDigest,
  );
  manifest.recipeSelections.push({ recipeDigest: expectedDigest, instanceId });
  manifest.selectedConfigurationId = configurationId;
  return {
    manifest: validateDiskBoxManifest(manifest),
    newBlobs,
    configurationId,
    reused: false,
  };
}
