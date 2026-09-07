import { copySavedMachine } from "./saved-machine.js";
import { validateDriveSetSnapshotV4 } from "./drive-set-v4.js";
import { fetchTwoMibSystem } from "./two-mib-system.js";

/** Construct a private configuration candidate. Publication, predecessor backup
 * and cold reboot belong to the workspace; this function changes no live state.
 * The caller must explicitly confirm any slots omitted by a smaller count.
 */
export async function prepareTwoMibConfiguration({
  snapshot,
  configuredCount,
  CpmDisk,
  deployment,
  baseUrl,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
}) {
  if (
    !Number.isInteger(configuredCount) ||
    configuredCount < 1 ||
    configuredCount > 16
  )
    throw new Error("Configured slots must be an integer from 1 to 16.");
  // Capture every byte before the first await, including media that the new
  // count excludes. The workspace separately retains the complete predecessor.
  const owned = copySavedMachine(snapshot);
  const existing = owned.schema === "triptych-drive-set-v4";
  const previous = existing ? owned.slots : [owned.drives.A, owned.drives.B];
  const { system, bootstrap, descriptor } = await fetchTwoMibSystem({
    deployment,
    configuredCount,
    baseUrl,
    fetch,
    crypto,
  });
  const slots = Array.from({ length: configuredCount }, () => null);
  for (
    let index = 0;
    index < Math.min(previous.length, configuredCount);
    index++
  ) {
    const source = previous[index];
    if (source === null) continue;
    let bytes = source.bytes;
    if (!existing) {
      const disk = new CpmDisk(bytes);
      try {
        // A data disk receives a zero reserved area on format migration, never
        // another boot system. A same-format image retains its reserved tail.
        bytes =
          disk.geometry_id() === "triptych-cpm-2m-v1"
            ? bytes
            : disk.migrate_to_two_mib(
                index === 0 ? system : new Uint8Array(16384),
              );
      } finally {
        disk.free();
      }
    }
    if (index === 0) bytes.set(system.subarray(0, 6656));
    slots[index] = {
      instanceId: existing ? source.instanceId : crypto.randomUUID(),
      name: source.name,
      bytes,
    };
  }
  const candidate = {
    schema: "triptych-drive-set-v4",
    configuredCount,
    bootstrap: { profile: descriptor.residentProfile, bytes: bootstrap },
    slots,
  };
  validateDriveSetSnapshotV4(candidate);
  return { snapshot: candidate, descriptor };
}
