const PROFILE = "triptych-cpm-8m-v1";
const ASSET = `system-${PROFILE}.bin`;
const SHA256 = /^[0-9a-f]{64}$/;

function requireValue(condition, detail) {
  if (!condition) throw new Error(`Disk upgrade: ${detail}.`);
}

async function hash(bytes, crypto) {
  requireValue(crypto?.subtle, "SHA-256 unavailable");
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Closed, one-drive resident profile; disk geometry does not imply drive count.
 * Verify a private copy before returning it. Hashes detect mixed deployments,
 * not malicious replacement of the complete site (they are not signatures).
 */
export async function fetchLargeDiskSystem({
  deployment,
  bootstrap,
  ccp,
  bdos,
  baseUrl,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
}) {
  // Snapshot metadata and resident bytes before the first asynchronous step.
  const manifest = JSON.parse(JSON.stringify(deployment ?? null));
  const boot = bootstrap.slice();
  const command = ccp.slice();
  const operatingSystem = bdos.slice();
  requireValue(
    manifest?.schema === "triptych-browser-deployment-v1" &&
      Array.isArray(manifest.diskProfiles) &&
      Array.isArray(manifest.assets),
    "verified disk profile unavailable",
  );
  const profiles = manifest.diskProfiles.filter(
    (item) => item?.residentProfile === "triptych-cpu-v0.1-8m-a",
  );
  requireValue(profiles.length === 1, "missing or duplicate disk profile");
  const profile = profiles[0];
  requireValue(
    profile.id === PROFILE &&
      profile.residentProfile === "triptych-cpu-v0.1-8m-a" &&
      profile.imageBytes === 8388608 &&
      profile.systemBytes === 16384 &&
      profile.drives === 1 &&
      profile.systemAsset === ASSET &&
      SHA256.test(profile.bootstrapSha256) &&
      SHA256.test(profile.ccpSha256) &&
      SHA256.test(profile.bdosSha256) &&
      profile.bios?.source === "system/cpm/bios-8m.asm" &&
      SHA256.test(profile.bios.sourceSha256) &&
      SHA256.test(profile.bios.sha256),
    "unsupported resident profile",
  );
  const matches = manifest.assets.filter((item) => item?.path === ASSET);
  const boots = manifest.assets.filter(
    (item) => item?.path === "bootstrap.bin",
  );
  requireValue(
    matches.length === 1 && boots.length === 1,
    "missing or duplicate system asset",
  );
  const asset = matches[0];
  requireValue(
    asset.bytes === 16384 &&
      SHA256.test(asset.sha256) &&
      boots[0].bytes === boot.length &&
      boots[0].sha256 === profile.bootstrapSha256,
    "invalid system asset identity",
  );
  requireValue(
    command.length === 0x800 &&
      operatingSystem.length === 0xe00 &&
      (await hash(boot, crypto)) === profile.bootstrapSha256 &&
      (await hash(command, crypto)) === profile.ccpSha256 &&
      (await hash(operatingSystem, crypto)) === profile.bdosSha256,
    "loaded residents differ from this deployment",
  );
  const base = new URL(baseUrl);
  requireValue(
    ["http:", "https:"].includes(base.protocol),
    "invalid asset URL",
  );
  const response = await fetch(new URL(ASSET, base).href, {
    cache: "no-store",
    redirect: "error",
  });
  requireValue(response.ok, "system asset could not be loaded");
  const bytes = new Uint8Array(await response.arrayBuffer());
  requireValue(
    bytes.length === asset.bytes &&
      (await hash(bytes, crypto)) === asset.sha256,
    "system asset verification failed",
  );
  requireValue(
    (await hash(bytes.subarray(0, 0x800), crypto)) === profile.ccpSha256 &&
      (await hash(bytes.subarray(0x800, 0x1600), crypto)) ===
        profile.bdosSha256 &&
      (await hash(bytes.subarray(0x1600, 0x1a00), crypto)) ===
        profile.bios.sha256 &&
      bytes.subarray(0x1a00).every((byte) => byte === 0),
    "resident slots or reserved bytes differ from the profile",
  );
  return bytes;
}

function closedObject(value, keys, detail) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join("|") === [...keys].sort().join("|"),
    detail,
  );
}

/** A/B is a separate resident identity, not a geometry inference or an upgrade
 * of currently loaded bytes. All metadata is captured before network awaits.
 */
export async function fetchLargeAbDiskSystem({
  deployment,
  baseUrl,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
}) {
  const manifest = JSON.parse(JSON.stringify(deployment ?? null));
  const residentProfile = "triptych-cpu-v0.1-8m-ab";
  const systemAsset = "system-triptych-cpm-8m-ab-v1.bin";
  const bootstrapAsset = "bootstrap-triptych-cpm-8m-ab-v1.bin";
  requireValue(
    manifest?.schema === "triptych-browser-deployment-v1" &&
      Array.isArray(manifest.diskProfiles) &&
      Array.isArray(manifest.assets),
    "verified A/B disk profile unavailable",
  );
  const profiles = manifest.diskProfiles.filter(
    (item) => item?.residentProfile === residentProfile,
  );
  requireValue(profiles.length === 1, "missing or duplicate A/B disk profile");
  const profile = profiles[0];
  closedObject(
    profile,
    [
      "id",
      "residentProfile",
      "imageBytes",
      "systemBytes",
      "drives",
      "systemAsset",
      "systemSha256",
      "bootstrapAsset",
      "bootstrapSha256",
      "residentLockSha256",
      "ccpSha256",
      "bdosSha256",
      "bios",
    ],
    "A/B disk profile fields",
  );
  closedObject(
    profile.bios,
    ["source", "sourceSha256", "sha256", "liveEnd"],
    "A/B BIOS fields",
  );
  requireValue(
    profile.id === PROFILE &&
      profile.imageBytes === 8388608 &&
      profile.systemBytes === 16384 &&
      profile.drives === 2 &&
      profile.systemAsset === systemAsset &&
      profile.bootstrapAsset === bootstrapAsset &&
      profile.bios.source === "system/cpm/bios-8m-ab.asm" &&
      Number.isInteger(profile.bios.liveEnd) &&
      profile.bios.liveEnd > 0xf900 &&
      profile.bios.liveEnd <= 0xfc00 &&
      [
        profile.systemSha256,
        profile.bootstrapSha256,
        profile.residentLockSha256,
        profile.ccpSha256,
        profile.bdosSha256,
        profile.bios.sha256,
        profile.bios.sourceSha256,
      ].every((value) => typeof value === "string" && SHA256.test(value)),
    "unsupported A/B resident profile",
  );
  const identities = [
    [systemAsset, 16384, profile.systemSha256],
    [bootstrapAsset, 256, profile.bootstrapSha256],
  ];
  // Validate both identities before any fetch, including closed asset rows.
  for (const [path, length, digest] of identities) {
    const assets = manifest.assets.filter((item) => item?.path === path);
    requireValue(assets.length === 1, "missing or duplicate A/B asset");
    closedObject(assets[0], ["path", "bytes", "sha256"], "A/B asset fields");
    requireValue(
      assets[0].bytes === length && assets[0].sha256 === digest,
      "A/B asset identity mismatch",
    );
  }
  const base = new URL(baseUrl);
  requireValue(
    ["http:", "https:"].includes(base.protocol),
    "invalid asset URL",
  );
  const [system, bootstrap] = await Promise.all(
    identities.map(async ([path, length, digest]) => {
      const response = await fetch(new URL(path, base).href, {
        cache: "no-store",
        redirect: "error",
      });
      requireValue(response.ok, "A/B asset could not be loaded");
      const bytes = new Uint8Array(await response.arrayBuffer()).slice();
      requireValue(
        bytes.length === length && (await hash(bytes, crypto)) === digest,
        "A/B asset verification failed",
      );
      return bytes;
    }),
  );
  requireValue(
    (await hash(system.subarray(0, 0x800), crypto)) === profile.ccpSha256 &&
      (await hash(system.subarray(0x800, 0x1600), crypto)) ===
        profile.bdosSha256 &&
      (await hash(system.subarray(0x1600, 0x1a00), crypto)) ===
        profile.bios.sha256 &&
      system
        .subarray(profile.bios.liveEnd - 0xe300)
        .every((byte) => byte === 0),
    "A/B resident slots or reserved bytes differ from the profile",
  );
  return { system, bootstrap, profile: residentProfile };
}
