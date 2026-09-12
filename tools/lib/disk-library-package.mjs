import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { validateDiskLibraryRetention } from "./disk-library-retention.mjs";

const MAX_METADATA = 16 * 1024 * 1024;
const MAX_TOTAL = 1024 * 1024 * 1024;

async function boundedRead(path, limit, expected, openFile) {
  const file = await openFile(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await file.stat();
    if (
      !info.isFile() ||
      info.size > limit ||
      (expected !== undefined && info.size !== expected)
    )
      throw new Error("Retained library file size differs or exceeds bound.");
    // Read at most the admitted size plus one byte. A concurrent growth cannot
    // turn the earlier size check into an unbounded allocation or read.
    const buffer = Buffer.alloc(info.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await file.read(
        buffer,
        used,
        buffer.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== info.size)
      throw new Error("Retained library file changed during bounded read.");
    return buffer.subarray(0, used);
  } finally {
    await file.close();
  }
}

/** Read a checked-in retained package. Missing or invalid history is an error,
 * never an empty-library fallback. Validate paths and aggregate sizes before
 * opening asset files so untrusted metadata cannot escape the package root.
 */
export async function readDiskLibraryPackage(
  directory,
  { openFile = open } = {},
) {
  const registryPath = join(directory, "disk-library-registry.json");
  const bytes = await boundedRead(
    registryPath,
    MAX_METADATA,
    undefined,
    openFile,
  );
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const manifest = JSON.parse(text);
  const compact = text.replace(/"(?:[^"\\]|\\.)*"|\s+/g, (token) =>
    token.startsWith('"') ? token : "",
  );
  if (JSON.stringify(manifest) !== compact)
    throw new Error("Noncanonical or duplicate retained library metadata.");
  if (!Array.isArray(manifest.assets) || manifest.assets.length > 4096)
    throw new Error("Invalid retained library asset list.");
  let total = 0;
  const names = new Set();
  for (const row of manifest.assets) {
    if (
      !row ||
      typeof row.path !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(row.path) ||
      names.has(row.path) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      row.bytes > MAX_METADATA
    )
      throw new Error("Invalid retained library asset path or size.");
    names.add(row.path);
    total += row.bytes;
    if (total > MAX_TOTAL)
      throw new Error("Retained library exceeds total byte bound.");
  }
  const assets = new Map();
  for (const row of manifest.assets) {
    const path = join(directory, row.path);
    const payload = await boundedRead(path, row.bytes, row.bytes, openFile);
    assets.set(row.path, payload);
  }
  return validateDiskLibraryRetention({ manifest, assets });
}
