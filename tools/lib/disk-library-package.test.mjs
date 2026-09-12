import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readDiskLibraryPackage } from "./disk-library-package.mjs";

const empty = () => ({
  schema: "triptych-disk-library-retention-v1",
  assets: [],
  images: [],
  admissions: [],
  recipes: [],
  defaults: [],
});
async function fixture(t, manifest = empty()) {
  const directory = await mkdtemp(join(tmpdir(), "triptych-retained-package-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    join(directory, "disk-library-registry.json"),
    JSON.stringify(manifest),
  );
  return directory;
}
test("reads explicit empty history but never substitutes for missing history", async (t) => {
  const directory = await fixture(t);
  assert.deepEqual((await readDiskLibraryPackage(directory)).manifest, empty());
  await assert.rejects(
    readDiskLibraryPackage(join(directory, "missing")),
    /ENOENT/,
  );
});
test("reads exact hashed bytes and refuses corruption or missing assets", async (t) => {
  const payload = Buffer.from("retained"),
    sha256 = createHash("sha256").update(payload).digest("hex");
  const path = `retained-${sha256}.bin`,
    manifest = empty();
  manifest.assets.push({ path, bytes: payload.length, sha256 });
  const directory = await fixture(t, manifest);
  await assert.rejects(readDiskLibraryPackage(directory), /ENOENT/);
  await writeFile(join(directory, path), payload);
  assert.deepEqual(
    (await readDiskLibraryPackage(directory)).assets.get(path),
    new Uint8Array(payload),
  );
  await writeFile(join(directory, path), Buffer.alloc(payload.length));
  await assert.rejects(
    readDiskLibraryPackage(directory),
    /hash|digest|differs/i,
  );
});
test("rejects path escapes and oversized totals before opening any assets", async (t) => {
  const manifest = empty();
  manifest.assets = [{ path: "../outside.bin", bytes: 1 }];
  let directory = await fixture(t, manifest);
  await assert.rejects(readDiskLibraryPackage(directory), /path or size/);
  manifest.assets = Array.from({ length: 65 }, (_, n) => ({
    path: `payload-${n}.bin`,
    bytes: 16 * 1024 * 1024,
  }));
  directory = await fixture(t, manifest);
  await assert.rejects(readDiskLibraryPackage(directory), /total byte bound/);
});
test("rejects duplicate JSON keys and symlinked payloads", async (t) => {
  const directory = await fixture(t);
  await writeFile(
    join(directory, "disk-library-registry.json"),
    '{"assets":[],"assets":[]}',
  );
  await assert.rejects(readDiskLibraryPackage(directory), /duplicate/);
  const manifest = empty();
  manifest.assets = [{ path: "link.bin", bytes: 1 }];
  await writeFile(
    join(directory, "disk-library-registry.json"),
    JSON.stringify(manifest),
  );
  await writeFile(join(directory, "target.bin"), "x");
  await symlink("target.bin", join(directory, "link.bin"));
  await assert.rejects(readDiskLibraryPackage(directory), /ELOOP/);
});
test("concurrent asset growth stays capped and closes the captured handle", async (t) => {
  const manifest = empty();
  manifest.assets = [{ path: "growing.bin", bytes: 1 }];
  const directory = await fixture(t, manifest);
  await writeFile(join(directory, "growing.bin"), "x");
  let requested = 0,
    closed = false;
  await assert.rejects(
    readDiskLibraryPackage(directory, {
      openFile: async (path, flags) => {
        const handle = await open(path, flags);
        if (!path.endsWith("growing.bin")) return handle;
        return {
          stat: async () => {
            const info = await handle.stat();
            await writeFile(path, Buffer.alloc(1024));
            return info;
          },
          read: (...args) => {
            requested += args[2];
            return handle.read(...args);
          },
          close: async () => {
            closed = true;
            await handle.close();
          },
        };
      },
    }),
    /changed during bounded read/,
  );
  assert.equal(requested, 2, "one admitted byte plus one growth sentinel");
  assert.equal(closed, true);
});
