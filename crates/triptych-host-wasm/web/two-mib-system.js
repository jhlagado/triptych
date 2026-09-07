import { copyDriveSetV4 } from "./drive-set-v4.js";

const SHA256 = /^[0-9a-f]{64}$/;
const REVISION = /^[0-9a-f]{40}$/;
const OS_ROOT = "third_party/portable-cpm/2m/v0.1.4";
const METADATA = "PROFILE_METADATA_INVALID";

function failure(code, detail) {
  return Object.assign(new Error(`Two-MiB profile: ${detail}.`), { code });
}

function requireValue(condition, detail, code = METADATA) {
  if (!condition) throw failure(code, detail);
}

// These APIs accept JSON-like metadata, not objects with executable getters.
// Capture own data properties rather than invoking toJSON, iterators or getters.
function field(value, key) {
  const property = Object.getOwnPropertyDescriptor(value, key);
  requireValue(property && Object.hasOwn(property, "value"), `invalid ${key}`);
  return property.value;
}

function record(value, keys) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Reflect.ownKeys(value).length === keys.length,
    "unsupported descriptor fields",
  );
  return Object.fromEntries(keys.map((key) => [key, field(value, key)]));
}

function array(value, maximum) {
  requireValue(
    Array.isArray(value) && value.length <= maximum,
    "metadata array exceeds its limit",
  );
  requireValue(
    Reflect.ownKeys(value).length === value.length + 1,
    "metadata array must be dense with no extra fields",
  );
  return Array.from({ length: value.length }, (_, index) =>
    field(value, String(index)),
  );
}

function digest(value) {
  requireValue(
    typeof value === "string" && SHA256.test(value),
    "invalid SHA-256",
  );
  return value;
}

function same(value, expected, label) {
  requireValue(value === expected, `${label} differs from named profile`);
}

function layout(count) {
  requireValue(
    Number.isInteger(count) && count >= 1 && count <= 16,
    "configured count must be 1 through 16",
  );
  const allocationBytes = 256 * Math.ceil(count / 2);
  const allocationBase = 65536 - allocationBytes;
  const bios = allocationBase - 1024;
  const bdos = bios - 3584;
  return {
    ccp: bdos - 2048,
    bdos,
    bios,
    allocationBase,
    allocationBytes,
    commonLimit: bios + 768,
    dphBase: bios + 768,
    dphEnd: bios + 768 + count * 16,
  };
}

function source(value, expected) {
  same(value.source, expected, "source path");
  digest(value.sourceSha256);
  digest(value.preparedSourceSha256);
}

function descriptor(value) {
  const result = record(value, [
    "schema",
    "id",
    "residentProfile",
    "configuredCount",
    "imageBytes",
    "systemBytes",
    "layout",
    "system",
    "bootstrap",
    "residents",
    "bios",
    "atom",
    "machine",
  ]);
  const count = result.configuredCount;
  const expected = layout(count);
  const suffix = `n${String(count).padStart(2, "0")}`;
  const profile = `triptych-cpu-v0.1-2m-${suffix}`;
  same(result.schema, "triptych-two-mib-system-v1", "descriptor schema");
  same(result.id, "triptych-cpm-2m-v1", "format");
  same(result.residentProfile, profile, "resident profile");
  same(result.imageBytes, 2097152, "image size");
  same(result.systemBytes, 16384, "system size");
  result.layout = record(result.layout, Object.keys(expected));
  for (const [key, number] of Object.entries(expected))
    same(result.layout[key], number, key);
  result.system = record(result.system, ["asset", "bytes", "sha256"]);
  result.bootstrap = record(result.bootstrap, [
    "asset",
    "bytes",
    "sha256",
    "source",
    "sourceSha256",
    "preparedSourceSha256",
  ]);
  for (const [kind, bytes] of [
    ["system", 16384],
    ["bootstrap", 256],
  ]) {
    same(
      result[kind].asset,
      `${kind}-triptych-cpm-2m-${suffix}-v1.bin`,
      `${kind} asset`,
    );
    same(result[kind].bytes, bytes, `${kind} size`);
    digest(result[kind].sha256);
  }
  source(result.bootstrap, "roms/cpu/bootstrap-2m.asm");
  result.residents = record(result.residents, [
    "lock",
    "lockSha256",
    "manifest",
    "manifestSha256",
    "repository",
    "version",
    "revision",
    "ccp",
    "bdos",
  ]);
  const residents = result.residents;
  same(
    residents.lock,
    `distribution/residents-2m/${suffix}.lock.json`,
    "resident lock",
  );
  same(
    residents.manifest,
    `${OS_ROOT}/profiles/${profile}/manifest.json`,
    "release manifest",
  );
  same(
    residents.repository,
    "https://github.com/jhlagado/portable-cpm.git",
    "OS repository",
  );
  same(residents.version, "0.1.4", "OS version");
  same(
    residents.revision,
    "d28fc52774c967d1422b3b814d51c069247504c1",
    "OS revision",
  );
  digest(residents.lockSha256);
  digest(residents.manifestSha256);
  for (const [kind, offset, bytes] of [
    ["ccp", 0, 2048],
    ["bdos", 2048, 3584],
  ]) {
    const component = record(residents[kind], [
      "source",
      "sourceSha256",
      "preparedSourceSha256",
      "sha256",
      "offset",
      "origin",
      "bytes",
    ]);
    source(component, `${OS_ROOT}/src/${kind}.asm`);
    same(component.offset, offset, `${kind} offset`);
    same(component.origin, expected[kind], `${kind} origin`);
    same(component.bytes, bytes, `${kind} size`);
    digest(component.sha256);
    residents[kind] = component;
  }
  result.bios = record(result.bios, [
    "source",
    "sourceSha256",
    "preparedSourceSha256",
    "sha256",
    "commonEnd",
    "directoryBuffer",
    "dpb",
    "checksumVector",
  ]);
  source(result.bios, "system/cpm/bios-2m.asm");
  digest(result.bios.sha256);
  const bios = result.bios;
  requireValue(
    Number.isInteger(bios.dpb) &&
      bios.dpb >= expected.bios + 51 &&
      bios.directoryBuffer === bios.dpb + 15 &&
      bios.checksumVector === bios.directoryBuffer + 128 &&
      bios.commonEnd === bios.checksumVector + 32 &&
      bios.commonEnd <= expected.commonLimit,
    "BIOS common storage bounds",
  );
  result.atom = record(result.atom, [
    "repository",
    "revision",
    "package",
    "seed",
    "packageIntegrity",
  ]);
  same(
    result.atom.repository,
    "https://github.com/jhlagado/atom.git",
    "ATOM repository",
  );
  same(
    result.atom.revision,
    "802b5c2d320bec777f427755ff2d7338e3b80a05",
    "ATOM revision",
  );
  same(result.atom.package, "atom-z80", "ATOM package");
  result.atom.seed = record(result.atom.seed, ["bytes", "sha256"]);
  same(result.atom.seed.bytes, 64236, "ATOM seed size");
  same(
    result.atom.seed.sha256,
    "fdea19fbd8aeb6211469f043491610455a71547902cf451c3e684e49a8fa0fd6",
    "ATOM seed",
  );
  requireValue(
    typeof result.atom.packageIntegrity === "string" &&
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(result.atom.packageIntegrity),
    "ATOM package integrity",
  );
  result.machine = record(result.machine, [
    "revision",
    "dirty",
    "generator",
    "generatorSha256",
  ]);
  requireValue(
    typeof result.machine.revision === "string" &&
      REVISION.test(result.machine.revision) &&
      typeof result.machine.dirty === "boolean",
    "machine source identity",
  );
  same(
    result.machine.generator,
    "tools/lib/cpm-two-mib-profile.mjs",
    "machine generator",
  );
  digest(result.machine.generatorSha256);
  return result;
}

function capture(deployment, count) {
  layout(count);
  requireValue(
    deployment !== null && typeof deployment === "object",
    "deployment metadata missing",
  );
  same(
    field(deployment, "schema"),
    "triptych-browser-deployment-v1",
    "deployment schema",
  );
  if (!Object.hasOwn(deployment, "twoMibProfiles")) return null;
  const profiles = array(field(deployment, "twoMibProfiles"), 16).map(
    descriptor,
  );
  const counts = new Set();
  for (const profile of profiles) {
    requireValue(
      !counts.has(profile.configuredCount),
      "duplicate resident profile",
    );
    counts.add(profile.configuredCount);
  }
  // Qualified subset registries need not duplicate the complete distribution.
  // A supplied outer source identity, however, may not contradict any profile.
  if (Object.hasOwn(deployment, "distribution")) {
    const distribution = field(deployment, "distribution");
    requireValue(
      distribution !== null &&
        typeof distribution === "object" &&
        !Array.isArray(distribution),
      "invalid distribution metadata",
    );
    if (Object.hasOwn(distribution, "triptych")) {
      const machine = field(distribution, "triptych");
      requireValue(
        machine !== null &&
          typeof machine === "object" &&
          !Array.isArray(machine),
        "invalid distribution machine metadata",
      );
      for (const key of ["revision", "dirty"])
        if (Object.hasOwn(machine, key)) {
          const value = field(machine, key);
          requireValue(
            key === "revision"
              ? typeof value === "string" && REVISION.test(value)
              : typeof value === "boolean",
            "invalid outer machine identity",
          );
          for (const profile of profiles)
            same(profile.machine[key], value, `outer machine ${key}`);
        }
    }
  }
  const selected = profiles.find(
    (profile) => profile.configuredCount === count,
  );
  // Validate the present collection even when the requested profile is absent.
  const assets = array(field(deployment, "assets"), 4096).map((value) => {
    const asset = record(value, ["path", "bytes", "sha256"]);
    requireValue(
      typeof asset.path === "string" &&
        asset.path.length <= 255 &&
        /^[A-Za-z0-9_.-]+$/.test(asset.path) &&
        ![".", ".."].includes(asset.path) &&
        Number.isSafeInteger(asset.bytes) &&
        asset.bytes >= 0,
      "invalid asset row",
    );
    digest(asset.sha256);
    return asset;
  });
  requireValue(
    new Set(assets.map((asset) => asset.path)).size === assets.length,
    "duplicate asset",
  );
  for (const profile of profiles) {
    for (const role of ["system", "bootstrap"]) {
      const reference = profile[role];
      const asset = assets.find((item) => item.path === reference.asset);
      requireValue(
        asset &&
          asset.bytes === reference.bytes &&
          asset.sha256 === reference.sha256,
        "asset identity differs from profile",
      );
    }
  }
  return selected ?? null;
}

async function hash(bytes, crypto) {
  requireValue(
    crypto?.subtle && typeof crypto.subtle.digest === "function",
    "SHA-256 unavailable",
    "PROFILE_HASH_UNAVAILABLE",
  );
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function cancelQuietly(stream) {
  // A broken cancellation promise must not delay bounded rejection forever.
  try {
    Promise.resolve(stream?.cancel()).catch(() => {});
  } catch {
    /* Already closed, locked, or unavailable. */
  }
}

async function fetchAsset(reference, base, fetch) {
  const url = new URL(reference.asset, base);
  requireValue(url.origin === base.origin, "cross-origin asset", METADATA);
  let response;
  try {
    response = await fetch(url.href, { cache: "no-store", redirect: "error" });
  } catch {
    throw failure(
      "PROFILE_ASSET_UNAVAILABLE",
      `${reference.asset} could not be loaded`,
    );
  }
  const usable =
    response?.ok &&
    !response.redirected &&
    (!response.url || response.url === url.href) &&
    typeof response.body?.getReader === "function";
  if (!usable) cancelQuietly(response?.body);
  requireValue(
    usable,
    "asset response unavailable or redirected",
    "PROFILE_ASSET_UNAVAILABLE",
  );
  let reader;
  try {
    reader = response.body.getReader();
  } catch {
    throw failure("PROFILE_ASSET_UNAVAILABLE", "asset stream is not readable");
  }
  const bytes = new Uint8Array(reference.bytes);
  let used = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      requireValue(
        part.value instanceof Uint8Array &&
          part.value.buffer instanceof ArrayBuffer,
        "invalid response bytes",
        "PROFILE_ASSET_INVALID",
      );
      requireValue(
        part.value.byteLength <= bytes.length - used,
        "asset exceeds size limit",
        "PROFILE_ASSET_INVALID",
      );
      bytes.set(part.value, used);
      used += part.value.byteLength;
    }
    requireValue(
      used === bytes.length,
      "truncated asset",
      "PROFILE_ASSET_INVALID",
    );
    return bytes;
  } catch (error) {
    cancelQuietly(reader);
    if (error?.code === "PROFILE_ASSET_INVALID") throw error;
    throw failure("PROFILE_ASSET_UNAVAILABLE", "asset stream failed");
  } finally {
    reader.releaseLock();
  }
}

function verifyMachine(system, bootstrap, profile) {
  const fail = (condition, detail) =>
    requireValue(condition, detail, "PROFILE_ASSET_INVALID");
  const word = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);
  const bios = system.subarray(5632, 6656);
  const { layout: addresses, configuredCount: count } = profile;
  const offset = (address) => address - addresses.bios;
  const equals = (bytes, expected) =>
    bytes.length === expected.length &&
    expected.every((value, index) => bytes[index] === value);
  fail(
    system.subarray(6656).every((byte) => byte === 0),
    "nonzero reserved system tail",
  );
  fail(
    equals(
      bios.subarray(
        offset(profile.bios.dpb),
        offset(profile.bios.directoryBuffer),
      ),
      [128, 0, 4, 15, 0, 247, 3, 255, 3, 255, 255, 0, 0, 1, 0],
    ),
    "DPB differs from geometry",
  );
  fail(
    bios
      .subarray(offset(profile.bios.commonEnd), 768)
      .every((byte) => byte === 0),
    "nonzero common BIOS padding",
  );
  for (let drive = 0; drive < count; drive++) {
    const words = Array.from({ length: 8 }, (_, index) =>
      word(bios, 768 + drive * 16 + index * 2),
    );
    fail(
      equals(words, [
        0,
        0,
        0,
        0,
        profile.bios.directoryBuffer,
        profile.bios.dpb,
        profile.bios.checksumVector,
        addresses.allocationBase + drive * 128,
      ]),
      "DPH or ALV differs from count",
    );
  }
  fail(
    bios.subarray(768 + count * 16).every((byte) => byte === 0),
    "nonzero unused DPH padding",
  );
  const select = offset(word(bios, 28));
  fail(
    bios[27] === 0xc3 &&
      select >= 51 &&
      select + 7 <= offset(profile.bios.dpb) &&
      equals(bios.subarray(select, select + 7), [
        0x79,
        0xfe,
        count,
        0x21,
        0,
        0,
        0xd0,
      ]),
    "SELDSK configured count differs",
  );
  fail(
    bootstrap[0] === 0xf3 &&
      bootstrap[1] === 0x31 &&
      word(bootstrap, 2) === addresses.ccp - 256 &&
      word(bootstrap, 16) === addresses.ccp - 272 &&
      bootstrap[19] === 52 &&
      word(bootstrap, 21) === addresses.ccp - 271 &&
      word(bootstrap, 24) === addresses.ccp,
    "bootstrap layout differs",
  );
}

/** Fetch a fresh installation tuple. Does not read, install or publish saved
 * media. Integrity checks reject mixed deployments; they are not signatures.
 */
export async function fetchTwoMibSystem({
  deployment,
  configuredCount,
  baseUrl,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
}) {
  const profile = capture(deployment, configuredCount);
  if (!profile)
    throw failure("PROFILE_UNAVAILABLE", "named profile is unavailable");
  let base;
  try {
    base = new URL(baseUrl);
  } catch {
    throw failure(METADATA, "invalid asset base URL");
  }
  requireValue(
    ["http:", "https:"].includes(base.protocol) &&
      !base.username &&
      !base.password,
    "invalid asset base URL",
  );
  requireValue(
    typeof fetch === "function",
    "fetch unavailable",
    "PROFILE_ASSET_UNAVAILABLE",
  );
  // Sequential, at most one bounded response reader; no all-profile cache.
  const system = await fetchAsset(profile.system, base, fetch);
  const bootstrap = await fetchAsset(profile.bootstrap, base, fetch);
  for (const [bytes, expected] of [
    [system, profile.system.sha256],
    [bootstrap, profile.bootstrap.sha256],
    [system.subarray(0, 2048), profile.residents.ccp.sha256],
    [system.subarray(2048, 5632), profile.residents.bdos.sha256],
    [system.subarray(5632, 6656), profile.bios.sha256],
  ])
    requireValue(
      (await hash(bytes, crypto)) === expected,
      "asset digest differs",
      "PROFILE_ASSET_INVALID",
    );
  verifyMachine(system, bootstrap, profile);
  return { system, bootstrap, descriptor: profile };
}

/** Admit preserved saved bytes without fetching or comparing resident payloads.
 * Returns exactly one owned snapshot. Unavailable is not corrupt saved data and
 * must not authorize seeding over durable authority. A consistent paired-count
 * relabelling cannot prove historical BIOS identity or bootability in v4.
 */
export async function admitTwoMibSavedMachine({
  snapshot,
  deployment,
  crypto = globalThis.crypto,
}) {
  let owned;
  try {
    owned = copyDriveSetV4(snapshot);
  } catch (error) {
    throw failure("SAVED_MACHINE_INVALID", error.message);
  }
  const profile = capture(deployment, owned.configuredCount);
  if (!profile)
    return {
      status: "unavailable",
      snapshot: owned,
      code: "PROFILE_UNAVAILABLE",
      reason: "Named profile is unavailable.",
    };
  if ((await hash(owned.bootstrap.bytes, crypto)) !== profile.bootstrap.sha256)
    return {
      status: "unavailable",
      snapshot: owned,
      code: "SAVED_BOOTSTRAP_MISMATCH",
      reason: "Saved bootstrap is not admitted by this descriptor.",
    };
  return { status: "admitted", snapshot: owned, descriptor: profile };
}
