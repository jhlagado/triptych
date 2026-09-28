import { fetchTwoMibSystem as defaultFetchTwoMibSystem } from "./two-mib-system.js";

const encoder = new TextEncoder();
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FILE_NAME = /^[A-Za-z0-9_$#@?-]{1,8}(?:\.[A-Za-z0-9_$#@?-]{1,3})?$/;
const PROFILE = /^triptych-cpu-v0\.1-2m-n(?:0[1-9]|1[0-6])$/;
const MAX_DESCRIPTOR_BYTES = 16 * 1024;
const MAX_COMPONENTS = 32;
const MAX_FILES = 64;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_FILE_BYTES = 1024 * 1024;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Workspace recipe: ${message}.`);
}

function record(value, required, optional = []) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)),
    "invalid record",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(
    required.every((key) => Object.hasOwn(descriptors, key)) &&
      Reflect.ownKeys(descriptors).every(
        (key) =>
          typeof key === "string" &&
          [...required, ...optional].includes(key) &&
          Object.hasOwn(descriptors[key], "value"),
      ),
    "unsupported descriptor fields",
  );
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, item]) => [key, item.value]),
  );
}

function text(value, label, maximum) {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= maximum &&
      value.isWellFormed() &&
      !/[\u0000-\u001f\u007f]/u.test(value) &&
      encoder.encode(value).length <= maximum,
    `invalid ${label}`,
  );
  return value;
}

function hash(value) {
  requireValue(
    typeof value === "string" && HASH.test(value),
    "invalid SHA-256",
  );
  return value;
}

function id(value, label = "identifier") {
  requireValue(typeof value === "string" && ID.test(value), `invalid ${label}`);
  return value;
}

function fileReference(value) {
  const input = record(value, ["name", "url", "bytes", "sha256"]);
  requireValue(
    typeof input.name === "string" && FILE_NAME.test(input.name),
    "invalid CP/M filename",
  );
  requireValue(
    typeof input.url === "string" && input.url.length <= 2048,
    "invalid file URL",
  );
  requireValue(
    Number.isInteger(input.bytes) &&
      input.bytes > 0 &&
      input.bytes <= MAX_FILE_BYTES,
    "invalid file size",
  );
  hash(input.sha256);
  return {
    name: input.name.toUpperCase(),
    url: input.url,
    bytes: input.bytes,
    sha256: input.sha256,
  };
}

/** Validate a small, transport-only file recipe. No bytes are fetched here. */
export function canonicalWorkspaceRecipeDescriptor(value) {
  const input = record(
    value,
    [
      "schema",
      "id",
      "revision",
      "name",
      "instruction",
      "profile",
      "components",
    ],
    ["workDrives"],
  );
  requireValue(
    input.schema === "triptych-file-recipe-v1",
    "unsupported recipe schema",
  );
  id(input.id, "recipe id");
  id(input.revision, "recipe revision");
  text(input.name, "recipe name", 128);
  requireValue(
    typeof input.instruction === "string" &&
      input.instruction.length <= 255 &&
      input.instruction.isWellFormed(),
    "invalid instruction",
  );
  requireValue(PROFILE.test(input.profile), "unsupported machine profile");
  requireValue(
    Array.isArray(input.components) &&
      input.components.length > 0 &&
      input.components.length <= MAX_COMPONENTS &&
      Reflect.ownKeys(input.components).length === input.components.length + 1,
    "invalid components",
  );
  const components = [];
  const componentIds = new Set();
  let fileCount = 0;
  let totalBytes = 0;
  for (const raw of input.components) {
    const component = record(raw, ["id", "name", "description", "files"]);
    id(component.id, "component id");
    requireValue(!componentIds.has(component.id), "duplicate component id");
    componentIds.add(component.id);
    text(component.name, "component name", 128);
    requireValue(
      typeof component.description === "string" &&
        component.description.length <= 255 &&
        component.description.isWellFormed(),
      "invalid component description",
    );
    requireValue(
      Array.isArray(component.files) &&
        component.files.length > 0 &&
        component.files.length <= MAX_FILES &&
        Reflect.ownKeys(component.files).length === component.files.length + 1,
      "invalid component files",
    );
    const files = component.files.map((entry) => {
      fileCount += 1;
      requireValue(fileCount <= MAX_FILES, "too many files");
      const result = fileReference(entry);
      totalBytes += result.bytes;
      requireValue(
        totalBytes <= MAX_TOTAL_FILE_BYTES,
        "recipe files exceed 1 MiB",
      );
      return result;
    });
    components.push({
      id: component.id,
      name: component.name,
      description: component.description,
      files,
    });
  }
  const count = Number(input.profile.slice(-2));
  const workDrives = input.workDrives ?? ["B"];
  requireValue(
    Array.isArray(workDrives) &&
      workDrives.length >= 1 &&
      workDrives.length <= Math.min(count - 1, 3) &&
      new Set(workDrives).size === workDrives.length &&
      workDrives.every(
        (drive) => typeof drive === "string" && /^[BCD]$/.test(drive),
      ),
    "invalid writable drives",
  );
  const result = {
    schema: input.schema,
    id: input.id,
    revision: input.revision,
    name: input.name,
    instruction: input.instruction,
    profile: input.profile,
    components,
    workDrives: [...workDrives],
  };
  requireValue(
    encoder.encode(JSON.stringify(result)).length <= MAX_DESCRIPTOR_BYTES,
    "recipe metadata exceeds 16 KiB",
  );
  return result;
}

async function digest(bytes, crypto) {
  requireValue(crypto?.subtle, "cryptography unavailable");
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function workspaceRecipeDigest(
  descriptor,
  { crypto = globalThis.crypto } = {},
) {
  return digest(
    encoder.encode(
      JSON.stringify(canonicalWorkspaceRecipeDescriptor(descriptor)),
    ),
    crypto,
  );
}

async function responseBytes(response, limit, label) {
  requireValue(
    response?.ok && !response.redirected && response.body?.getReader,
    `${label} could not be loaded`,
  );
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      requireValue(
        value instanceof Uint8Array && value.buffer instanceof ArrayBuffer,
        `${label} returned invalid bytes`,
      );
      length += value.byteLength;
      requireValue(length <= limit, `${label} exceeds its declared size`);
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
    offset += chunk.byteLength;
  }
  return bytes;
}

async function fetchJson(url, fetch, label) {
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  const bytes = await responseBytes(response, MAX_DESCRIPTOR_BYTES, label);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `Workspace recipe: ${label} is not valid JSON (${error.message}).`,
    );
  }
}

async function fetchFile(reference, recipeUrl, fetch, crypto) {
  const url = new URL(reference.url, recipeUrl);
  requireValue(
    url.protocol === "https:" && !url.username && !url.password && !url.hash,
    `file ${reference.name} must use an HTTPS URL without credentials or fragments`,
  );
  const response = await fetch(url.href, {
    cache: "no-store",
    credentials: "omit",
    redirect: "error",
  });
  const bytes = await responseBytes(response, reference.bytes, reference.name);
  requireValue(
    bytes.byteLength === reference.bytes,
    `${reference.name} is truncated`,
  );
  requireValue(
    (await digest(bytes, crypto)) === reference.sha256,
    `${reference.name} failed SHA-256 verification`,
  );
  return bytes;
}

function selectFiles(descriptor, componentIds) {
  const requested =
    componentIds ?? descriptor.components.map((component) => component.id);
  requireValue(
    Array.isArray(requested) &&
      requested.length > 0 &&
      requested.length <= descriptor.components.length &&
      new Set(requested).size === requested.length &&
      requested.every((item) => typeof item === "string" && ID.test(item)),
    "invalid component selection",
  );
  const selected = descriptor.components.filter((component) =>
    requested.includes(component.id),
  );
  requireValue(
    selected.length === requested.length,
    "component selection is not in the recipe",
  );
  const files = [];
  const names = new Map();
  for (const component of selected) {
    for (const file of component.files) {
      const key = file.name.toUpperCase();
      const previous = names.get(key);
      requireValue(
        !previous ||
          (previous.bytes === file.bytes &&
            previous.sha256 === file.sha256 &&
            previous.url === file.url),
        `components contain conflicting ${file.name}`,
      );
      if (!previous) {
        names.set(key, file);
        files.push(file);
      }
    }
  }
  return { requested, files };
}

/**
 * Resolve a static file recipe into a new writable CP/M system disk. The
 * recipe and every file are verified before the candidate is returned; no
 * browser storage or running machine is touched here.
 */
export async function loadWorkspaceLaunch({
  url,
  deployment,
  baseUrl,
  CpmDisk,
  fetchTwoMibSystem = defaultFetchTwoMibSystem,
  fetch = globalThis.fetch,
  crypto = globalThis.crypto,
  componentIds,
}) {
  requireValue(
    typeof CpmDisk?.create_two_mib === "function",
    "CP/M disk support missing",
  );
  requireValue(
    typeof fetch === "function" && crypto?.subtle,
    "host support missing",
  );
  const source = new URL(url, baseUrl);
  requireValue(
    source.protocol === "https:" &&
      !source.username &&
      !source.password &&
      !source.hash,
    "an HTTPS recipe URL without credentials or fragments is required",
  );
  const anonymousFetch = (target, options) =>
    fetch(target, { ...options, credentials: "omit" });
  const raw = await fetchJson(source.href, anonymousFetch, "recipe descriptor");
  const descriptor = canonicalWorkspaceRecipeDescriptor(raw);
  const selected = selectFiles(descriptor, componentIds);
  const count = Number(descriptor.profile.slice(-2));
  const [system, fileBytes] = await Promise.all([
    fetchTwoMibSystem({
      deployment,
      configuredCount: count,
      baseUrl,
      fetch,
      crypto,
    }),
    Promise.all(
      selected.files.map((reference) =>
        fetchFile(reference, source.href, anonymousFetch, crypto),
      ),
    ),
  ]);
  requireValue(
    system.descriptor.residentProfile === descriptor.profile,
    "recipe profile differs from the admitted Triptych system",
  );
  const blank = CpmDisk.create_two_mib();
  let disk;
  try {
    const bytes = blank.export_source();
    bytes.set(system.system, 0);
    disk = new CpmDisk(bytes);
  } finally {
    blank.free?.();
  }
  const names = new Set(disk.file_names());
  try {
    for (let index = 0; index < selected.files.length; index += 1) {
      const reference = selected.files[index];
      const canonical = CpmDisk.canonical_name(reference.name);
      requireValue(
        !names.has(canonical) || canonical === reference.name,
        `invalid canonical name for ${reference.name}`,
      );
      const existing = names.has(canonical);
      if (existing) {
        const current = disk.read_file(canonical);
        requireValue(
          current.byteLength >= reference.bytes &&
            (await digest(current.slice(0, reference.bytes), crypto)) ===
              reference.sha256 &&
            current.slice(reference.bytes).every((byte) => byte === 0x1a),
          `${canonical} already exists with different bytes`,
        );
      } else {
        disk.add_import(canonical, fileBytes[index]);
        names.add(canonical);
      }
    }
    const image = new Uint8Array(disk.export_candidate());
    const recipeDigest = await workspaceRecipeDigest(descriptor, { crypto });
    return {
      id: descriptor.id,
      name: descriptor.name,
      instruction: descriptor.instruction,
      profile: descriptor.profile,
      configuredCount: count,
      imageSha256: await digest(image, crypto),
      image,
      bootstrap: system.bootstrap,
      storageNamespace: `triptych-workspace-${recipeDigest}`,
      seedWorkDisk: false,
      workDrives: descriptor.workDrives,
      recipeDigest,
      components: selected.requested,
      files: selected.files.map((file) => file.name),
    };
  } finally {
    disk.free?.();
  }
}
