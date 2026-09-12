import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  diskLibraryBuildMode as mode,
  selectDiskLibraryBuild as select,
} from "./disk-library-build-guard.mjs";

const empty = { manifest: { recipes: [], defaults: [] }, assets: new Map() };
const pinned = {
  manifest: {
    recipes: [
      { id: "starter", revision: "old-starter" },
      { id: "library", revision: "old-library" },
    ],
    defaults: [
      { id: "starter", revision: "old-starter" },
      { id: "library", revision: "old-library" },
    ],
  },
  assets: new Map([["old", new Uint8Array([1])]]),
};
test("browser publication requires complete pinned defaults and forbids refresh", () => {
  assert.throws(
    () => mode({ browser: true, release: true, previous: empty }),
    /requires a pinned/,
  );
  for (const previous of [empty, pinned])
    assert.throws(
      () => mode({ browser: true, release: true, refresh: true, previous }),
      /cannot refresh/,
    );
  assert.throws(
    () =>
      mode({
        browser: true,
        release: true,
        previous: {
          manifest: {
            ...pinned.manifest,
            defaults: [pinned.manifest.defaults[0]],
          },
        },
      }),
    /requires a pinned/,
  );
  assert.equal(
    mode({ browser: true, release: true, previous: pinned }),
    "pinned",
  );
});
test("development initial and explicit refresh remain candidate workflows", () => {
  assert.equal(
    mode({ browser: true, release: false, previous: empty }),
    "candidate",
  );
  assert.equal(
    mode({ browser: true, release: false, refresh: true, previous: pinned }),
    "candidate",
  );
  assert.equal(
    mode({ browser: true, release: false, previous: pinned }),
    "pinned",
  );
  assert.equal(mode({ browser: false, release: true }), "none");
  assert.throws(
    () => mode({ browser: false, refresh: true }),
    /requires a browser/,
  );
});
test("normal release selects exact pin without merging candidate defaults or assets", () => {
  const candidate = {
    manifest: {
      recipes: [{ id: "starter", revision: "unpinned" }],
      defaults: [{ id: "starter", revision: "unpinned" }],
    },
    assets: new Map([["new", new Uint8Array([2])]]),
  };
  const chosen = select(
    mode({ browser: true, release: true, previous: pinned }),
    pinned,
    candidate,
    () => {
      throw new Error("must not merge");
    },
  );
  assert.equal(chosen, pinned);
  assert.equal(chosen.assets, pinned.assets);
  assert.equal(
    JSON.stringify(chosen.manifest, null, 2),
    JSON.stringify(pinned.manifest, null, 2),
  );
  const merged = {};
  assert.equal(
    select("candidate", pinned, candidate, (before, next, options) => {
      assert.equal(before, pinned);
      assert.equal(next, candidate);
      assert.equal(options.defaults, candidate.manifest.defaults);
      return merged;
    }),
    merged,
  );
});
test("builder preflights policy before cargo and uses captured pin for final selection", async () => {
  const source = await readFile(
    new URL("../build-wasm-host.mjs", import.meta.url),
    "utf8",
  );
  assert.equal(
    (source.match(/await readDiskLibraryPackage\(/g) ?? []).length,
    1,
  );
  const guard = source.indexOf(
    "const libraryBuildMode = diskLibraryBuildMode(",
  );
  assert(guard >= 0 && guard < source.indexOf('run("cargo", cargoArguments)'));
  assert(guard < source.indexOf("const stagingRoot = await mkdtemp("));
  assert.match(
    source,
    /retainedLibrary = selectDiskLibraryBuild\(\s*libraryBuildMode,\s*previousLibrary,\s*retainedLibrary,\s*mergeDiskLibraryRetention/s,
  );
});
