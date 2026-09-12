import { copySavedMachine } from "./saved-machine.js";
import { emptyDiskBox, validateDiskBoxManifest } from "./disk-box.js";

function requireValue(condition, message) {
  if (!condition) throw new Error(`Disk box adoption: ${message}.`);
}

// Capture only data properties; never run getters or caller-supplied slice/map.
// In particular, Buffer.slice() is a view, so normalize byte inputs ourselves.
function capture(value) {
  if (value instanceof ArrayBuffer)
    return new Uint8Array(ArrayBuffer.prototype.slice.call(value, 0));
  if (ArrayBuffer.isView(value)) {
    requireValue(
      value.buffer instanceof ArrayBuffer,
      "shared bytes unsupported",
    );
    return new Uint8Array(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  if (value === null || typeof value !== "object") {
    requireValue(typeof value !== "function", "non-data input");
    return value;
  }
  requireValue(
    Array.isArray(value) ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null,
    "unsupported input object",
  );
  const result = Array.isArray(value) ? new Array(value.length) : {};
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireValue(
      typeof key === "string" && Object.hasOwn(descriptor, "value"),
      "accessor or symbol input",
    );
    Object.defineProperty(result, key, {
      value: capture(descriptor.value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

function geometry(bytes) {
  const formats = new Map([
    [256512, "ibm3740"],
    [2097152, "triptych-cpm-2m-v1"],
    [8388608, "triptych-cpm-8m-v1"],
  ]);
  requireValue(
    formats.has(bytes),
    "historical image size requires explicit recovery",
  );
  return formats.get(bytes);
}

/** Preserve a saved machine as private disks; no profile or image conversion.
 * Retain this returned candidate and its operation ID for storage retries.
 * Snapshot formats have no persisted access field: omitted slotWritable means
 * writable personal media. Callers with access metadata must provide it.
 */
export async function prepareSavedMachineAdoption(
  snapshot,
  {
    configurationId,
    name,
    slotWritable,
    crypto = globalThis.crypto,
    createDiskId = () => crypto.randomUUID(),
  } = {},
) {
  const captured = capture(snapshot);
  if (
    captured?.schema === "triptych-drive-set-v4" &&
    captured.slots?.[0] === null
  ) {
    const error = new Error(
      "Disk box adoption: select an explicit system disk recovery binding for missing A.",
    );
    error.code = "SYSTEM_DISK_SELECTION_REQUIRED";
    throw error;
  }
  const owned = copySavedMachine(captured);
  const v4 = Object.hasOwn(owned, "schema");
  const count = v4
    ? owned.configuredCount
    : owned.bootstrap.profile === "triptych-cpu-v0.1-8m-ab"
      ? 2
      : 1;
  const media = v4
    ? owned.slots
    : [owned.drives.A, owned.drives.B].slice(0, count);
  const access =
    slotWritable === undefined
      ? Array(count).fill(true)
      : capture(slotWritable);
  requireValue(
    Array.isArray(access) &&
      access.length === count &&
      Reflect.ownKeys(access).length === count + 1 &&
      Array.from(
        { length: count },
        (_, i) => Object.hasOwn(access, i) && typeof access[i] === "boolean",
      ).every(Boolean),
    "slotWritable must be a dense boolean array matching configured slots",
  );
  const personalDisks = [],
    slots = [];
  // UUID creation and metadata validation finish before the first hash yields.
  for (const [index, disk] of media.entries()) {
    if (disk === null) {
      slots.push(null);
      continue;
    }
    const id = v4 ? disk.instanceId : createDiskId();
    personalDisks.push({
      id,
      name: disk.name,
      geometry: geometry(disk.bytes.length),
      content: { sha256: "0".repeat(64), byteLength: disk.bytes.length },
    });
    slots.push({ kind: "personal", diskId: id, writable: access[index] });
  }
  let manifest = validateDiskBoxManifest({
    ...emptyDiskBox(),
    personalDisks,
    configurations: [
      {
        id: configurationId,
        name,
        configuredCount: count,
        bootstrap: {
          profile: owned.bootstrap.profile,
          bytes: Array.from(owned.bootstrap.bytes),
        },
        systemDisk: slots[0],
        slots,
      },
    ],
    selectedConfigurationId: configurationId,
  });
  requireValue(crypto?.subtle, "cryptography unavailable");
  const newBlobs = new Map();
  let diskIndex = 0;
  for (const disk of media) {
    if (disk === null) continue;
    const sha256 = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", disk.bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const prior = newBlobs.get(sha256);
    requireValue(
      !prior ||
        (prior.length === disk.bytes.length &&
          prior.every((byte, i) => byte === disk.bytes[i])),
      "content hash collision",
    );
    if (!prior) newBlobs.set(sha256, disk.bytes);
    manifest.personalDisks[diskIndex++].content.sha256 = sha256;
  }
  manifest = validateDiskBoxManifest(manifest);
  return { manifest, newBlobs };
}
