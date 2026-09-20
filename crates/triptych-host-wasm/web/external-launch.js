import { fetchDirectImage } from "./direct-launch.js";
import { fetchTwoMibSystem } from "./two-mib-system.js";

function requireValue(value, message) {
  if (!value) throw new Error(`External system: ${message}.`);
}

// Release publishers supply data only. Bootstrap and emulator code always come
// from Triptych's admitted deployment, and resident bytes must match exactly.
export async function loadExternalLaunch({
  url,
  deployment,
  baseUrl,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
}) {
  const source = new URL(url);
  requireValue(
    source.protocol === "https:",
    "an HTTPS release URL is required",
  );
  requireValue(
    !source.username && !source.password && !source.hash,
    "invalid release URL",
  );
  const anonymousFetch = (target, options) =>
    fetch(target, { ...options, credentials: "omit" });
  const response = await anonymousFetch(source.href, {
    cache: "no-store",
    redirect: "error",
  });
  requireValue(
    response.ok && !response.redirected,
    "release descriptor could not be loaded",
  );
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      requireValue(length <= 16384, "release descriptor exceeds 16 KiB");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const descriptor = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  requireValue(
    descriptor.schema === "triptych-external-system-v1",
    "unknown descriptor format",
  );
  requireValue(
    typeof descriptor.name === "string" &&
      descriptor.name.length > 0 &&
      descriptor.name.length <= 128,
    "invalid name",
  );
  requireValue(
    typeof descriptor.instruction === "string" &&
      descriptor.instruction.length <= 255,
    "invalid instruction",
  );
  requireValue(
    /^triptych-cpu-v0\.1-2m-n(?:0[2-9]|1[0-6])$/.test(descriptor.profile),
    "unsupported machine profile",
  );
  const image = descriptor.image;
  requireValue(
    image &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(image.asset) &&
      image.bytes === 2097152 &&
      /^[a-f0-9]{64}$/.test(image.sha256),
    "invalid image reference",
  );
  requireValue(
    ["blank", "copy-image"].includes(descriptor.workDisk),
    "unsupported work disk seed",
  );
  const count = Number(descriptor.profile.slice(-2));
  const [disk, system] = await Promise.all([
    fetchDirectImage(image, new URL(".", source), anonymousFetch, crypto),
    fetchTwoMibSystem({
      deployment,
      configuredCount: count,
      baseUrl,
      fetch,
      crypto,
    }),
  ]);
  requireValue(
    system.descriptor.residentProfile === descriptor.profile,
    "machine profile differs",
  );
  requireValue(
    disk
      .subarray(0, system.system.length)
      .every((byte, index) => byte === system.system[index]),
    "disk residents are incompatible with this Triptych release",
  );
  return {
    id: "external",
    name: descriptor.name,
    instruction: descriptor.instruction,
    profile: descriptor.profile,
    configuredCount: count,
    image: disk,
    bootstrap: system.bootstrap,
    seedWorkDisk: descriptor.workDisk === "copy-image",
  };
}
