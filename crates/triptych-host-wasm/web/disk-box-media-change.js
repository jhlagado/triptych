import {
  validateDiskBoxManifest,
  mountDiskBoxSlot,
  prepareDiskBoxCheckpoint,
} from "./disk-box.js";

function requireValue(condition, message) {
  if (!condition) throw new Error(`Disk change: ${message}.`);
}

/** Caller holds the UI/workspace management barrier and has drained autosaves.
 * Preparation owns incoming bytes before awaiting, then stops the scheduler and
 * holds a WASM ticket across publication. The guest must separately close files,
 * flush and reset the changed drive's BDOS login state after insertion.
 *
 * A failed publication is ambiguous: keep the ticket and scheduler stopped. The
 * same session's commit() retries the same operation/bytes. Never cancel after
 * publication starts; reload durable authority if the session cannot recover.
 */
export async function prepareDiskBoxMediaChange({
  manifest,
  token,
  configurationId,
  slot,
  binding,
  incomingBytes,
  cpu,
  store,
  lease,
  pause,
  resume,
  onCommitted,
  crypto = globalThis.crypto,
  operationId = crypto.randomUUID(),
}) {
  const captured = validateDiskBoxManifest(manifest);
  const candidate = mountDiskBoxSlot(captured, configurationId, slot, binding);
  const config = candidate.configurations.find(
    (item) => item.id === configurationId,
  );
  const oldConfig = captured.configurations.find(
    (item) => item.id === configurationId,
  );
  const next = config.slots[slot];
  const expected = structuredClone(token);
  requireValue(
    crypto?.subtle && typeof operationId === "string" && operationId.length > 0,
    "invalid operation",
  );
  const owned = () => lease?.isOwner?.() === true;
  requireValue(owned(), "writer ownership required");
  requireValue(
    !(
      next?.kind === "personal" &&
      oldConfig.slots[slot]?.kind === "personal" &&
      next.diskId === oldConfig.slots[slot].diskId
    ),
    "eject before reinserting the same personal disk",
  );
  let bytes;
  if (next !== null) {
    const image =
      next.kind === "published"
        ? next.image
        : captured.personalDisks.find((disk) => disk.id === next.diskId)
            .content;
    requireValue(
      incomingBytes instanceof Uint8Array &&
        incomingBytes.buffer instanceof ArrayBuffer &&
        incomingBytes.byteLength === image.byteLength,
      "incoming image length differs",
    );
    bytes = new Uint8Array(incomingBytes);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    requireValue(digest === image.sha256, "incoming image hash differs");
  } else
    requireValue(incomingBytes === undefined, "ejection must not supply bytes");
  requireValue(owned(), "writer ownership lost before preparation");
  pause();
  let ticket = 0;
  let prepared;
  try {
    requireValue(
      cpu.disk_management_ready(),
      "guest has pending input or unflushed disk work",
    );
    ticket =
      next === null
        ? cpu.prepare_drive_eject(slot)
        : cpu.prepare_drive_change(
            slot,
            bytes,
            next.kind === "personal" && next.writable,
          );
    requireValue(ticket !== 0, "runtime rejected preparation");
    const updates = new Map();
    for (const [index, current] of oldConfig.slots.entries()) {
      if (current?.kind === "personal" && current.writable)
        updates.set(current.diskId, cpu.export_drive_checkpoint(index));
    }
    const checkpoint = await prepareDiskBoxCheckpoint(
      captured,
      configurationId,
      updates,
      crypto,
    );
    prepared = {
      manifest: mountDiskBoxSlot(
        checkpoint.manifest,
        configurationId,
        slot,
        next,
      ),
      newBlobs: checkpoint.newBlobs,
    };
    requireValue(owned(), "writer ownership lost while preparing");
  } catch (error) {
    const cancelled = ticket === 0 || cpu.cancel_media_change(ticket);
    if (cancelled && owned()) resume();
    if (!cancelled)
      throw new AggregateError(
        [error],
        "Disk change preparation failed; runtime remains stopped for recovery.",
      );
    throw error;
  }
  let state = "prepared";
  return Object.freeze({
    get status() {
      return state;
    },
    cancel() {
      requireValue(
        state === "prepared",
        "publication has started; cancellation is unsafe",
      );
      requireValue(
        cpu.cancel_media_change(ticket),
        "ticket cancellation failed; recover before resuming",
      );
      state = "cancelled";
      if (owned()) resume();
    },
    async commit() {
      requireValue(
        state === "prepared" || state === "uncertain",
        "session cannot publish in its current state",
      );
      requireValue(owned(), "writer ownership required to commit");
      state = "publishing";
      let publication;
      try {
        publication = await store.commitChange(
          expected,
          operationId,
          prepared.manifest,
          prepared.newBlobs,
        );
      } catch (error) {
        state = "uncertain";
        throw error;
      }
      if (publication?.status !== "committed" || !owned()) {
        state = "recovery";
        throw new Error(
          "Disk change: authority advanced or ownership was lost; reload durable state without resuming.",
        );
      }
      state = "recovery";
      if (!cpu.commit_media_change(ticket)) {
        throw new Error(
          "Disk change: durable change committed but runtime ticket failed; reload durable state.",
        );
      }
      // Metadata activation must finish before the scheduler can observe the new
      // backing. If it throws, the committed runtime remains paused for recovery.
      await onCommitted({
        manifest: validateDiskBoxManifest(prepared.manifest),
        token: structuredClone(publication.token),
        configurationId,
        slot,
        binding: next === null ? null : structuredClone(next),
      });
      requireValue(owned(), "writer ownership lost before resume");
      state = "committed";
      resume();
      return publication;
    },
  });
}
