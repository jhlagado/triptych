import { copySavedMachine } from "./saved-machine.js";
import { admitTwoMibSavedMachine } from "./two-mib-system.js";

function requireValue(condition, message) {
  if (!condition) throw new Error(`Saved runtime: ${message}.`);
}

// This scope deliberately receives no source snapshot or installation arrays.
// WASM owns installed media; only the small bootstrap and metadata remain here.
function runtimeHandle(
  initialCpu,
  media,
  bootstrap,
  lengths,
  version,
  systemGuardEnabled,
) {
  let cpu = initialCpu;
  const active = () => {
    requireValue(cpu !== null, "runtime is disposed");
    return cpu;
  };
  return Object.freeze({
    get cpu() {
      return active();
    },
    media,
    systemGuardEnabled,
    captureCheckpoint() {
      const current = active();
      const slots = media.slots.map((slot, index) => {
        if (slot === null) return null;
        // TriptychCpu exports an owned copy at the acknowledged guest-flush
        // boundary. Never substitute export_drive's live, unflushed backing.
        const bytes = current.export_drive_checkpoint(index);
        requireValue(
          bytes instanceof Uint8Array &&
            bytes.buffer instanceof ArrayBuffer &&
            bytes.byteLength === lengths[index],
          "invalid checkpoint export",
        );
        return { ...slot, bytes };
      });
      const savedBootstrap = {
        profile: media.profile,
        bytes: bootstrap.slice(),
      };
      return version === 4
        ? {
            schema: "triptych-drive-set-v4",
            configuredCount: media.configuredCount,
            bootstrap: savedBootstrap,
            slots,
          }
        : {
            bootstrap: savedBootstrap,
            drives: { A: slots[0], B: slots[1] ?? null },
          };
    },
    flushCounts() {
      const current = active();
      return media.slots.map((slot, index) =>
        slot === null ? 0 : current.drive_flush_count(index),
      );
    },
    dispose() {
      if (cpu === null) return;
      const releasing = cpu;
      cpu = null;
      releasing.free();
    },
  });
}

/** Prepare only: admit and own saved inputs, install media, then reset without
 * executing any guest instructions. The caller owns scheduling/activation and
 * must use dispose(), not cpu.free(), to release the returned runtime. There is
 * no storage publication or permission to seed on admission failure.
 */
export async function prepareSavedMachineRuntime({
  snapshot,
  TriptychCpu,
  writable = false,
  slotWritable,
  deployment,
  guardSystemDisk = false,
  crypto = globalThis.crypto,
}) {
  requireValue(typeof writable === "boolean", "writable must be boolean");
  requireValue(
    typeof guardSystemDisk === "boolean",
    "guardSystemDisk must be boolean",
  );
  // Global ownership can disable writes, never override protected mount policy.
  // Capture policy before runtime admission yields to hashing or downloads.
  let access;
  if (slotWritable !== undefined) {
    requireValue(
      Array.isArray(slotWritable) &&
        slotWritable.length >= 1 &&
        slotWritable.length <= 16 &&
        Reflect.ownKeys(slotWritable).length === slotWritable.length + 1,
      "invalid slot write policy",
    );
    access = Array.from({ length: slotWritable.length }, (_, index) => {
      const field = Object.getOwnPropertyDescriptor(slotWritable, index);
      requireValue(
        field &&
          Object.hasOwn(field, "value") &&
          typeof field.value === "boolean",
        "invalid slot write policy",
      );
      return field.value;
    });
  }
  requireValue(typeof TriptychCpu === "function", "CPU constructor required");
  let owned, systemDescriptor;
  if (
    snapshot !== null &&
    typeof snapshot === "object" &&
    Object.hasOwn(snapshot, "schema")
  ) {
    requireValue(
      snapshot.schema === "triptych-drive-set-v4",
      "unsupported snapshot schema",
    );
    const originalSlots = Object.getOwnPropertyDescriptor(
      snapshot,
      "slots",
    )?.value;
    if (
      guardSystemDisk &&
      Array.isArray(originalSlots) &&
      Object.getOwnPropertyDescriptor(originalSlots, "0")?.value === null
    )
      throw Object.assign(
        new Error(
          "Saved runtime: restore the retained system disk to A before boot.",
        ),
        { code: "SYSTEM_DISK_RESTORE_REQUIRED" },
      );
    const admission = await admitTwoMibSavedMachine({
      snapshot,
      deployment,
      crypto,
    });
    if (admission.status !== "admitted") {
      const error = new Error(`Saved runtime: ${admission.reason}`);
      error.code = admission.code;
      throw error;
    }
    owned = admission.snapshot;
    systemDescriptor = admission.descriptor;
  } else {
    requireValue(
      !guardSystemDisk,
      "system guard requires a two-MiB admitted profile",
    );
    // Retain the historical validator's complete accepted recovery domain.
    owned = copySavedMachine(snapshot);
  }
  if (guardSystemDisk) {
    const digest = async (bytes) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    // admission owns both bytes and closed descriptor before its first await.
    // Authenticate the preserved system; never fetch/reseed a replacement here.
    const system = owned.slots[0].bytes.subarray(0, 16384);
    if ((await digest(system)) !== systemDescriptor.system.sha256)
      throw Object.assign(
        new Error(
          "Saved runtime: A does not contain the admitted system; explicitly restore the retained system disk.",
        ),
        { code: "SYSTEM_DISK_RESTORE_REQUIRED" },
      );
    for (const [start, end, expected] of [
      [0, 2048, systemDescriptor.residents.ccp.sha256],
      [2048, 5632, systemDescriptor.residents.bdos.sha256],
      [5632, 6656, systemDescriptor.bios.sha256],
    ])
      requireValue(
        (await digest(system.subarray(start, end))) === expected,
        "system resident hash differs from descriptor",
      );
  }
  const version = Object.hasOwn(owned, "schema") ? 4 : 3;
  const profile = owned.bootstrap.profile;
  const slots =
    version === 4
      ? owned.slots
      : profile === "triptych-cpu-v0.1-8m-ab"
        ? [owned.drives.A, owned.drives.B]
        : [owned.drives.A];
  const media = Object.freeze({
    profile,
    configuredCount: slots.length,
    slots: Object.freeze(
      slots.map((slot) =>
        slot === null
          ? null
          : Object.freeze({
              name: slot.name,
              ...(version === 4 ? { instanceId: slot.instanceId } : {}),
            }),
      ),
    ),
  });
  requireValue(
    access === undefined || access.length === slots.length,
    "slot policy count differs",
  );
  const lengths = slots.map((slot) => slot?.bytes.byteLength ?? 0);
  const bootstrap = new Uint8Array(owned.bootstrap.bytes);
  const cpu = new TriptychCpu(bootstrap.slice());
  try {
    for (const [index, slot] of slots.entries())
      if (slot !== null)
        cpu.install_drive(
          index,
          slot.bytes,
          writable && (access?.[index] ?? true),
        );
    if (guardSystemDisk)
      requireValue(
        typeof cpu.configure_system_guard === "function" &&
          cpu.configure_system_guard(
            owned.slots[0].bytes.subarray(0, 6656),
            systemDescriptor.layout.bios,
          ),
        "WASM system guard rejected admitted system",
      );
    cpu.reset();
  } catch (error) {
    try {
      cpu.free();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Saved runtime preparation and cleanup failed.",
      );
    }
    throw error;
  }
  return runtimeHandle(
    cpu,
    media,
    bootstrap,
    lengths,
    version,
    guardSystemDisk,
  );
}
