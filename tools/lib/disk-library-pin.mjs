import { constants } from "node:fs";
import { open, link, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID, webcrypto } from "node:crypto";
import { readDiskLibraryPackage } from "./disk-library-package.mjs";
import {
  validateDiskLibraryRetention,
  mergeDiskLibraryRetention,
} from "./disk-library-retention.mjs";
import {
  loadDiskLibraryRegistry,
  resolveDiskLibraryRecipe,
} from "../../crates/triptych-host-wasm/web/disk-library-registry.js";

const REGISTRY = "disk-library-registry.json";
const LOCK = ".disk-library-pin.lock";
async function syncDirectory(directory) {
  const handle = await open(directory, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function verifyExisting(path, expected) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== expected.length)
      throw new Error(`Immutable asset collision: ${path}`);
    const bytes = Buffer.alloc(expected.length + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        used,
        bytes.length - used,
        null,
      );
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used !== expected.length || !bytes.subarray(0, used).equals(expected))
      throw new Error(`Immutable asset collision: ${path}`);
  } finally {
    await handle.close();
  }
}
async function stage(directory, bytes) {
  const path = join(directory, `.disk-library-pin-${randomUUID()}.tmp`);
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(path);
    throw error;
  }
  await handle.close();
  return path;
}

/** Append a previously release-qualified package. The CLI owns release checks;
 * this writer owns immutable bytes, whole-history merge and atomic publication.
 * Defaults advance only when explicitly requested. Existing history must exist.
 * No history/asset is deleted, including unreferenced assets from interrupted
 * attempts. Temporary files and this invocation's lock are the only cleanup.
 * A process crash leaves its lock in place; never guess whether it is stale.
 */
export async function pinDiskLibraryPackage(
  historyDirectory,
  incoming,
  options = {},
) {
  return writePackage(
    historyDirectory,
    validateDiskLibraryRetention(incoming),
    options,
  );
}

/** Browser qualification is deliberately stronger than generic retention.
 * Qualify every retained recipe, not only current defaults, using owned package
 * bytes without filesystem/network reads. Bulk seed/image bytes have already
 * been hash-checked by retention and are not copied into response bodies.
 * The CLI additionally requires complete clean release deployment evidence.
 */
export async function pinQualifiedDiskLibraryPackage(
  historyDirectory,
  incoming,
  options = {},
) {
  const candidate = validateDiskLibraryRetention(incoming);
  const baseUrl = "https://retained-package.invalid/";
  const registryBytes = Buffer.from(JSON.stringify(candidate.manifest));
  const fetch = async (url, init) => {
    const target = new URL(url);
    if (
      target.origin !== new URL(baseUrl).origin ||
      new URL(".", target).href !== baseUrl ||
      target.search ||
      target.hash ||
      target.username ||
      target.password ||
      init.cache !== "no-store" ||
      init.redirect !== "error"
    )
      throw new Error("Retained qualification requested an unadmitted URL");
    const name = target.pathname.slice(1);
    const bytes =
      name === REGISTRY ? registryBytes : candidate.assets.get(name);
    if (!bytes || !name.endsWith(".json"))
      throw new Error(
        "Retained qualification requested a missing or non-metadata payload",
      );
    return {
      ok: true,
      redirected: false,
      url,
      headers: new Headers({ "content-length": String(bytes.length) }),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    };
  };
  const registry = await loadDiskLibraryRegistry({
    baseUrl,
    fetch,
    crypto: webcrypto,
  });
  for (const { id, revision } of registry.metadata.recipes)
    await resolveDiskLibraryRecipe(registry, { id, revision });
  return writePackage(historyDirectory, candidate, options);
}

async function writePackage(
  historyDirectory,
  candidate,
  { advanceDefaults = false, beforeManifestPublish } = {},
) {
  if (typeof advanceDefaults !== "boolean")
    throw new Error("advanceDefaults must be boolean");
  const directory = resolve(historyDirectory);
  const lockPath = join(directory, LOCK);
  let lock;
  try {
    lock = await open(lockPath, "wx");
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error(
        `Library pin is locked: ${lockPath}. Investigate interrupted or concurrent publication; no automatic stale-lock removal.`,
      );
    throw error;
  }
  let temporary;
  try {
    await lock.writeFile(
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    );
    await lock.sync();
    const previous = await readDiskLibraryPackage(directory);
    const merged = mergeDiskLibraryRetention(
      previous,
      candidate,
      advanceDefaults ? { defaults: candidate.manifest.defaults } : {},
    );
    for (const [name, bytes] of merged.assets) {
      if (previous.assets.has(name)) continue; // Already verified by the locked reader.
      const target = join(directory, name);
      // Complete and sync bytes before creating the immutable final filename.
      // A crash can leave an orphan, never a partial hash-addressed asset.
      temporary = await stage(directory, bytes);
      try {
        await link(temporary, target);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        await verifyExisting(target, bytes);
      }
      await unlink(temporary);
      temporary = undefined;
    }
    await syncDirectory(directory);
    const bytes = Buffer.from(`${JSON.stringify(merged.manifest, null, 2)}\n`);
    temporary = await stage(directory, bytes);
    await beforeManifestPublish?.();
    await rename(temporary, join(directory, REGISTRY));
    temporary = undefined;
    await syncDirectory(directory);
    return {
      manifest: merged.manifest,
      assets: merged.assets.size,
      defaultsAdvanced: advanceDefaults,
    };
  } finally {
    if (temporary) await unlink(temporary);
    await lock.close();
    await unlink(lockPath);
  }
}
