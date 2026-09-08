import { fetchLargeAbDiskSystem } from "./disk-profile.js";
import { copyDriveSet } from "./drive-set.js";

function requireValue(condition, message) {
  if (!condition) throw new Error(`Supplied disks: ${message}.`);
}

/** Fetch one complete published A/B pair before the caller commits anything.
 * These hashes detect incomplete/mixed deployments; they are not signatures.
 * Saved machines never pass through this initializer.
 */
export async function fetchPublicDriveSet({
  deployment,
  baseUrl,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
}) {
  const manifest = JSON.parse(JSON.stringify(deployment ?? null));
  const descriptor = manifest?.publicDrives;
  requireValue(
    descriptor?.schema === "triptych-public-drives-v1" &&
      descriptor.profile === "triptych-cpu-v0.1-8m-ab" &&
      descriptor.bootstrapAsset === "bootstrap-triptych-cpm-8m-ab-v1.bin" &&
      Object.keys(descriptor.drives ?? {})
        .sort()
        .join() === "A,B" &&
      Array.isArray(manifest.assets),
    "missing or unsupported public distribution",
  );
  const base = new URL(baseUrl);
  requireValue(["https:", "http:"].includes(base.protocol), "invalid URL");
  const entries = [
    ["A", "drive-a-system.img"],
    ["B", "drive-b-games.img"],
  ];
  for (const [drive, path] of entries) {
    const entry = descriptor.drives[drive];
    const assets = manifest.assets.filter((asset) => asset.path === path);
    requireValue(
      entry?.path === path &&
        entry.name === path &&
        entry.bytes === 8388608 &&
        /^[a-f0-9]{64}$/.test(entry.sha256) &&
        assets.length === 1 &&
        assets[0].bytes === entry.bytes &&
        assets[0].sha256 === entry.sha256,
      `invalid ${drive}: image identity`,
    );
  }
  const resident = await fetchLargeAbDiskSystem({
    deployment: manifest,
    baseUrl,
    fetch,
    crypto,
  });
  const drives = {};
  await Promise.all(
    entries.map(async ([drive, path]) => {
      const entry = descriptor.drives[drive];
      const response = await fetch(new URL(path, base).href, {
        cache: "no-store",
        redirect: "error",
      });
      requireValue(response.ok, `${drive}: image could not be loaded`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      requireValue(bytes.length === entry.bytes, `${drive}: image size`);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      requireValue(
        digest === entry.sha256,
        `${drive}: image verification failed`,
      );
      requireValue(
        bytes
          .subarray(0, resident.system.length)
          .every((byte, index) =>
            drive === "A" ? byte === resident.system[index] : byte === 0,
          ),
        `${drive}: system area differs from its role`,
      );
      drives[drive] = { name: entry.name, bytes };
    }),
  );
  return copyDriveSet({
    bootstrap: { profile: resident.profile, bytes: resident.bootstrap },
    drives,
  });
}
