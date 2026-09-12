import { validateDiskBoxManifest } from "./disk-box.js";
import { fetchPublishedImage } from "./disk-catalogue.js";

/** Resolve a captured configuration without publishing storage or touching a CPU.
 * This verifies media identity, not system boot compatibility. Runtime admission
 * must still check the bootstrap/resident tuple before installing these bytes.
 */
export async function resolveDiskBoxConfiguration({
  manifest,
  configurationId,
  readPersonalDisk,
  fetchImage = fetchPublishedImage,
  crypto = globalThis.crypto,
}) {
  const captured = validateDiskBoxManifest(manifest);
  const configuration = captured.configurations.find(
    (item) => item.id === configurationId,
  );
  if (!configuration)
    throw new Error("Disk box runtime: unknown configuration.");
  if (!crypto?.subtle)
    throw new Error("Disk box runtime: cryptography unavailable.");
  const disks = new Map(captured.personalDisks.map((disk) => [disk.id, disk]));
  async function resolve(binding) {
    if (binding === null) return null;
    const published = binding.kind === "published";
    const metadata = published ? binding.image : disks.get(binding.diskId);
    const expected = published ? metadata : metadata.content;
    const input = published
      ? await fetchImage(metadata, { crypto })
      : await readPersonalDisk(metadata.id);
    if (
      !(input instanceof Uint8Array) ||
      !(input.buffer instanceof ArrayBuffer) ||
      input.byteLength !== expected.byteLength
    )
      throw new Error(
        "Disk box runtime: image length or representation differs.",
      );
    const bytes = new Uint8Array(input);
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    if (digest !== expected.sha256)
      throw new Error(
        "Disk box runtime: image changed from captured configuration.",
      );
    return {
      binding,
      name: metadata.name,
      geometry: metadata.geometry,
      writable: published ? false : binding.writable,
      bytes,
    };
  }
  const [slots, systemDisk] = await Promise.all([
    Promise.all(configuration.slots.map(resolve)),
    resolve(configuration.systemDisk),
  ]);
  return {
    configurationId: configuration.id,
    configuredCount: configuration.configuredCount,
    bootstrap: {
      profile: configuration.bootstrap.profile,
      bytes: Uint8Array.from(configuration.bootstrap.bytes),
    },
    slots,
    systemDisk,
  };
}
