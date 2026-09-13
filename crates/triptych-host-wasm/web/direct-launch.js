import { fetchTwoMibSystem } from "./two-mib-system.js";

const SHA256 = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Direct launch: ${message}.`);
}

function exactFields(value, fields, label) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join() === [...fields].sort().join(),
    `invalid ${label}`,
  );
}

async function fetchImage(reference, base, fetch, crypto) {
  const url = new URL(reference.asset, base);
  requireValue(url.origin === base.origin, "image is outside the app origin");
  const response = await fetch(url.href, {
    cache: "no-store",
    redirect: "error",
  });
  let reader;
  try {
    requireValue(
      response?.ok &&
        !response.redirected &&
        (!response.url || response.url === url.href) &&
        response.body?.getReader,
      "image could not be loaded",
    );
    const length = response.headers.get("content-length");
    const encoding = response.headers
      .get("content-encoding")
      ?.trim()
      .toLowerCase();
    if (length !== null && (!encoding || encoding === "identity"))
      requireValue(Number(length) === reference.bytes, "image length differs");
    reader = response.body.getReader();
    const bytes = new Uint8Array(reference.bytes);
    let offset = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      requireValue(
        value instanceof Uint8Array &&
          value.buffer instanceof ArrayBuffer &&
          value.byteLength <= bytes.length - offset,
        "image exceeds its declared size",
      );
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    requireValue(offset === bytes.length, "image is truncated");
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    requireValue(digest === reference.sha256, "image verification failed");
    return bytes;
  } catch (error) {
    try {
      Promise.resolve(
        reader ? reader.cancel() : response?.body?.cancel(),
      ).catch(() => {});
    } catch {}
    throw error;
  } finally {
    reader?.releaseLock();
  }
}

/** Load one immutable, stateless launch. This performs no browser-storage work. */
export async function loadDirectLaunch({
  deployment,
  id,
  baseUrl,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
}) {
  requireValue(typeof id === "string" && ID.test(id), "invalid software name");
  requireValue(
    typeof fetch === "function" && crypto?.subtle,
    "host support missing",
  );
  const collection = deployment?.directLaunches;
  exactFields(collection, ["schema", "launches"], "launch collection");
  requireValue(
    collection.schema === "triptych-direct-launches-v1" &&
      Array.isArray(collection.launches) &&
      collection.launches.length > 0 &&
      collection.launches.length <= 64,
    "unsupported launch collection",
  );
  const launches = new Map();
  for (const row of collection.launches) {
    exactFields(
      row,
      ["id", "name", "instruction", "profile", "image"],
      "launch entry",
    );
    requireValue(
      typeof row.id === "string" && ID.test(row.id),
      "invalid launch id",
    );
    requireValue(!launches.has(row.id), "duplicate launch id");
    requireValue(
      typeof row.name === "string" &&
        row.name.length > 0 &&
        row.name.length <= 255 &&
        typeof row.instruction === "string" &&
        row.instruction.length > 0 &&
        row.instruction.length <= 255,
      "invalid launch text",
    );
    requireValue(
      /^triptych-cpu-v0\.1-2m-n(?:0[1-9]|1[0-6])$/.test(row.profile),
      "invalid resident profile",
    );
    exactFields(row.image, ["asset", "bytes", "sha256"], "image reference");
    requireValue(
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(row.image.asset) &&
        row.image.bytes === 2097152 &&
        SHA256.test(row.image.sha256),
      "invalid image reference",
    );
    const matches = deployment.assets?.filter(
      (asset) => asset.path === row.image.asset,
    );
    requireValue(
      matches?.length === 1 &&
        matches[0].bytes === row.image.bytes &&
        matches[0].sha256 === row.image.sha256,
      "image is not part of this deployment",
    );
    launches.set(row.id, row);
  }
  const launch = launches.get(id);
  requireValue(launch, "unknown software name");
  const count = Number(launch.profile.slice(-2));
  const base = new URL(".", baseUrl);
  requireValue(["http:", "https:"].includes(base.protocol), "invalid app URL");
  const [image, system] = await Promise.all([
    fetchImage(launch.image, base, fetch, crypto),
    fetchTwoMibSystem({
      deployment,
      configuredCount: count,
      baseUrl: base.href,
      fetch,
      crypto,
    }),
  ]);
  requireValue(
    system.descriptor.residentProfile === launch.profile,
    "profile differs",
  );
  requireValue(
    image
      .subarray(0, system.system.length)
      .every((byte, index) => byte === system.system[index]),
    "boot system differs",
  );
  return {
    id: launch.id,
    name: launch.name,
    instruction: launch.instruction,
    profile: launch.profile,
    configuredCount: count,
    image,
    bootstrap: system.bootstrap,
  };
}
