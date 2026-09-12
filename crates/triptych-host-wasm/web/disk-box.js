// Persistent library metadata. Media bytes are content-addressed separately;
// published references never become personal disks by content equality.
import { validatePublishedImageReference } from "./disk-catalogue.js";

export const DISK_BOX_SCHEMA = "triptych-disk-box-v1";
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_BYTES = {
  ibm3740: 256512,
  "triptych-cpm-2m-v1": 2097152,
  "triptych-cpm-8m-v1": 8388608,
};
const encoder = new TextEncoder();
function requireValue(condition, message) {
  if (!condition) throw new Error(`Disk box: ${message}.`);
}
function record(value, keys, label) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) =>
        Object.hasOwn(
          Object.getOwnPropertyDescriptor(value, key) ?? {},
          "value",
        ),
      ),
    `invalid ${label} fields`,
  );
}
function array(value, max, label) {
  requireValue(
    Array.isArray(value) &&
      value.length <= max &&
      Reflect.ownKeys(value).length === value.length + 1 &&
      Array.from({ length: value.length }, (_, i) =>
        Object.hasOwn(Object.getOwnPropertyDescriptor(value, i) ?? {}, "value"),
      ).every(Boolean),
    `invalid ${label} array`,
  );
  // Do not invoke caller-supplied map/slice methods or indexed getters.
  return Array.from(
    { length: value.length },
    (_, i) => Object.getOwnPropertyDescriptor(value, i).value,
  );
}
function uuid(value) {
  requireValue(typeof value === "string" && UUID.test(value), "invalid UUID");
  return value;
}
function hash(value) {
  requireValue(typeof value === "string" && HASH.test(value), "invalid hash");
  return value;
}
function name(value) {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 255 &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      value.isWellFormed() &&
      encoder.encode(value).length <= 255,
    "invalid display name",
  );
  return value;
}
function geometry(value) {
  requireValue(
    typeof value === "string" && Object.hasOwn(IMAGE_BYTES, value),
    "unsupported geometry",
  );
  return value;
}
function unique(items, field, label) {
  const values = items.map((item) => item[field]);
  requireValue(new Set(values).size === values.length, `duplicate ${label}`);
  return new Map(items.map((item) => [item[field], item]));
}
function content(value, length) {
  record(value, ["sha256", "byteLength"], "content");
  requireValue(value.byteLength === length, "wrong image length");
  return { sha256: hash(value.sha256), byteLength: length };
}
function mount(value, disks) {
  if (value === null) return null;
  if (value?.kind === "published") {
    record(value, ["kind", "image"], "published mount");
    return {
      kind: "published",
      image: validatePublishedImageReference(value.image),
    };
  }
  record(value, ["kind", "diskId", "writable"], "personal mount");
  requireValue(
    value.kind === "personal" && typeof value.writable === "boolean",
    "invalid personal access",
  );
  const diskId = uuid(value.diskId);
  requireValue(disks.has(diskId), "missing personal disk");
  return { kind: "personal", diskId, writable: value.writable };
}
function profileGeometry(profile, count) {
  if (profile === `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`)
    return "triptych-cpm-2m-v1";
  if (profile === "legacy-e400" && count === 1) return "ibm3740";
  if (
    (profile === "triptych-cpu-v0.1-8m-a" && count === 1) ||
    (profile === "triptych-cpu-v0.1-8m-ab" && count === 2)
  )
    return "triptych-cpm-8m-v1";
  throw new Error(
    "Disk box: mismatched resident profile and configured count.",
  );
}

export function emptyDiskBox() {
  return {
    schema: DISK_BOX_SCHEMA,
    personalDisks: [],
    configurations: [],
    launchInstances: [],
    recipeSelections: [],
    selectedConfigurationId: null,
  };
}

/** Return detached canonical metadata; validate identities and all cross references. */
export function validateDiskBoxManifest(value) {
  record(
    value,
    [
      "schema",
      "personalDisks",
      "configurations",
      "launchInstances",
      "recipeSelections",
      "selectedConfigurationId",
    ],
    "manifest",
  );
  requireValue(value.schema === DISK_BOX_SCHEMA, "unsupported schema");
  const personalDisks = array(value.personalDisks, 256, "personal disks").map(
    (item) => {
      record(item, ["id", "name", "geometry", "content"], "personal disk");
      const format = geometry(item.geometry);
      return {
        id: uuid(item.id),
        name: name(item.name),
        geometry: format,
        content: content(item.content, IMAGE_BYTES[format]),
      };
    },
  );
  const disks = unique(personalDisks, "id", "personal disk");
  const configurations = array(value.configurations, 64, "configurations").map(
    (item) => {
      record(
        item,
        ["id", "name", "configuredCount", "bootstrap", "systemDisk", "slots"],
        "configuration",
      );
      const configuredCount = item.configuredCount;
      requireValue(
        Number.isInteger(configuredCount) &&
          configuredCount >= 1 &&
          configuredCount <= 16,
        "invalid configured count",
      );
      record(item.bootstrap, ["profile", "bytes"], "bootstrap");
      const format = profileGeometry(item.bootstrap.profile, configuredCount);
      const bytes = array(item.bootstrap.bytes, 256, "bootstrap bytes");
      requireValue(
        bytes.length === 256 &&
          bytes.every(
            (byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255,
          ),
        "invalid bootstrap bytes",
      );
      const slots = array(item.slots, 16, "slots").map((slot) =>
        mount(slot, disks),
      );
      requireValue(slots.length === configuredCount, "mismatched slot count");
      const systemDisk = mount(item.systemDisk, disks);
      requireValue(systemDisk !== null, "missing system disk recovery binding");
      const personalIds = slots
        .filter((slot) => slot?.kind === "personal")
        .map((slot) => slot.diskId);
      requireValue(
        new Set(personalIds).size === personalIds.length,
        "personal disk alias in slots",
      );
      for (const slot of [...slots, systemDisk]) {
        if (!slot) continue;
        const actual =
          slot.kind === "personal"
            ? disks.get(slot.diskId).geometry
            : slot.image.geometry;
        requireValue(
          actual === format,
          "mounted geometry differs from configuration",
        );
      }
      // A may be temporarily empty or contain data during a cooperative swap.
      // Boot admission verifies system bytes; the recovery binding is retained.
      return {
        id: uuid(item.id),
        name: name(item.name),
        configuredCount,
        bootstrap: { profile: item.bootstrap.profile, bytes: bytes.slice() },
        systemDisk,
        slots,
      };
    },
  );
  const configs = unique(configurations, "id", "configuration");
  const launchInstances = array(
    value.launchInstances,
    128,
    "launch instances",
  ).map((item) => {
    record(
      item,
      ["id", "recipeDigest", "configurationId", "roles"],
      "launch instance",
    );
    requireValue(
      configs.has(item.configurationId),
      "missing launch configuration",
    );
    const roles = array(item.roles, 16, "roles").map((role) => {
      record(role, ["role", "diskId"], "role");
      requireValue(
        typeof role.role === "string" &&
          /^[a-z][a-z0-9-]{0,63}$/.test(role.role),
        "invalid role",
      );
      requireValue(disks.has(role.diskId), "missing role disk");
      return { role: role.role, diskId: uuid(role.diskId) };
    });
    unique(roles, "role", "role");
    unique(roles, "diskId", "role disk");
    return {
      id: uuid(item.id),
      recipeDigest: hash(item.recipeDigest),
      configurationId: uuid(item.configurationId),
      roles,
    };
  });
  const instances = unique(launchInstances, "id", "launch instance");
  unique(launchInstances, "configurationId", "launch configuration");
  const recipeSelections = array(
    value.recipeSelections,
    128,
    "recipe selections",
  ).map((item) => {
    record(item, ["recipeDigest", "instanceId"], "recipe selection");
    const recipeDigest = hash(item.recipeDigest),
      instanceId = uuid(item.instanceId);
    requireValue(
      instances.get(instanceId)?.recipeDigest === recipeDigest,
      "missing or mismatched recipe instance",
    );
    return { recipeDigest, instanceId };
  });
  unique(recipeSelections, "recipeDigest", "recipe selection");
  const selectedConfigurationId =
    value.selectedConfigurationId === null
      ? null
      : uuid(value.selectedConfigurationId);
  requireValue(
    selectedConfigurationId === null
      ? configurations.length === 0
      : configs.has(selectedConfigurationId),
    "missing selected configuration",
  );
  return {
    schema: DISK_BOX_SCHEMA,
    personalDisks,
    configurations,
    launchInstances,
    recipeSelections,
    selectedConfigurationId,
  };
}

/** Personal content roots include ejected disks; published media has no local blob root. */
export function diskBoxReferences(value) {
  const manifest = validateDiskBoxManifest(value);
  const references = new Map();
  for (const disk of manifest.personalDisks) {
    const { sha256, byteLength } = disk.content;
    requireValue(
      !references.has(sha256) || references.get(sha256) === byteLength,
      "conflicting content lengths",
    );
    references.set(sha256, byteLength);
  }
  return references;
}

/** Prepare owned new blobs before yielding. Existing content is verified by the store. */
export async function prepareDiskBox(
  value,
  newBlobs = new Map(),
  crypto = globalThis.crypto,
) {
  const manifest = validateDiskBoxManifest(value),
    references = diskBoxReferences(manifest);
  requireValue(newBlobs instanceof Map, "invalid blob map");
  const blobs = [];
  for (const [sha256, input] of newBlobs) {
    requireValue(references.has(sha256), "unreferenced new blob");
    requireValue(
      input instanceof Uint8Array &&
        input.buffer instanceof ArrayBuffer &&
        input.byteLength === references.get(sha256),
      "invalid blob bytes",
    );
    blobs.push({ sha256, bytes: new Uint8Array(input) });
  }
  requireValue(crypto?.subtle, "cryptography unavailable");
  const digest = async (bytes) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  for (const blob of blobs)
    requireValue(
      (await digest(blob.bytes)) === blob.sha256,
      "blob hash mismatch",
    );
  return {
    manifest,
    digest: await digest(encoder.encode(JSON.stringify(manifest))),
    blobs,
  };
}

/** Return a validated new binding; ejection retains every personal disk. */
export function mountDiskBoxSlot(value, configurationId, slot, binding) {
  const result = validateDiskBoxManifest(value);
  const config = result.configurations.find(
    (item) => item.id === configurationId,
  );
  requireValue(
    config &&
      Number.isInteger(slot) &&
      slot >= 0 &&
      slot < config.configuredCount,
    "invalid slot selection",
  );
  config.slots[slot] = binding;
  return validateDiskBoxManifest(result);
}

/** Prepare acknowledged guest writes only. Mounting or editing library metadata
 * is a different operation: checkpoints cannot create disks or rewrite protected
 * media. Every ejected disk and every other configuration remains in the box.
 */
export async function prepareDiskBoxCheckpoint(
  value,
  configurationId,
  updates,
  crypto = globalThis.crypto,
) {
  const manifest = validateDiskBoxManifest(value);
  const configuration = manifest.configurations.find(
    (item) => item.id === configurationId,
  );
  requireValue(
    configuration && updates instanceof Map,
    "invalid checkpoint selection",
  );
  requireValue(crypto?.subtle, "cryptography unavailable");
  const writable = new Set(
    configuration.slots
      .filter((slot) => slot?.kind === "personal" && slot.writable)
      .map((slot) => slot.diskId),
  );
  const captured = [];
  for (const [diskId, input] of updates) {
    requireValue(
      writable.has(diskId),
      "checkpoint targets unmounted or protected disk",
    );
    const disk = manifest.personalDisks.find((item) => item.id === diskId);
    requireValue(
      input instanceof Uint8Array &&
        input.buffer instanceof ArrayBuffer &&
        input.byteLength === disk.content.byteLength,
      "invalid checkpoint bytes",
    );
    captured.push({ disk, bytes: new Uint8Array(input) });
  }
  const newBlobs = new Map();
  for (const { disk, bytes } of captured) {
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    disk.content = { sha256, byteLength: bytes.length };
    newBlobs.set(sha256, bytes);
  }
  return { manifest, newBlobs };
}
