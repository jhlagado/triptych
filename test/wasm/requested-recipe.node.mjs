import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { test } from "node:test";

const source = await readFile(
  new URL("../../crates/triptych-host-wasm/web/app.js", import.meta.url),
  "utf8",
);
const start = source.indexOf("for (const [id, freshInstance, libraryOnly");
const end = source.indexOf(
  'document\n  .querySelector("#library-backup")',
  start,
);
assert(start >= 0 && end > start);

test("public recipe links preview metadata in place and preserve native modified clicks", async () => {
  const previewStart = source.indexOf("async function previewRequestedRecipe("),
    previewEnd = source.indexOf(
      "async function runtimeDeployment(",
      previewStart,
    );
  assert(previewStart >= 0 && previewEnd > previewStart);
  const handlers = new Map(),
    elements = new Map(),
    resolved = [];
  const context = {
    URL,
    recipePreviewGeneration: 0,
    requestedRecipe: undefined,
    libraryStatus: {},
    document: {
      querySelector(id) {
        if (!elements.has(id))
          elements.set(id, {
            addEventListener: (_, handler) => handlers.set(id, handler),
          });
        return elements.get(id);
      },
    },
    registry: async () => "verified registry",
    resolveDiskLibraryRecipe: async (registry, reference) => {
      assert.equal(registry, "verified registry");
      resolved.push({ ...reference });
      return { reference, descriptor: { name: "Preview only" } };
    },
    libraryError: (error) => {
      throw error;
    },
  };
  vm.runInNewContext(source.slice(previewStart, previewEnd), context);
  for (const id of ["share-starter", "share-library", "share-colossal-cave"]) {
    const handler = handlers.get("#" + id);
    assert(handler);
    let prevented = false;
    const event = {
      button: 0,
      currentTarget: {
        href:
          "https://example.test/?recipe=arbitrary&revision=" + "b".repeat(64),
      },
      preventDefault() {
        prevented = true;
      },
    };
    for (const modifier of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
      { defaultPrevented: true },
    ]) {
      handler({ ...event, ...modifier });
      assert.equal(prevented, false);
    }
    handler(event);
    assert.equal(prevented, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(resolved.at(-1), {
      id: "arbitrary",
      revision: "b".repeat(64),
    });
    assert.equal(elements.get("#disk-library").open, true);
    assert.match(
      elements.get("#requested-recipe-description").textContent,
      /Preview only/,
    );
  }
  assert.equal(resolved.length, 3);
});

for (const accepted of [false, true]) {
  test(`requested recipe handler preserves exact identity and ${accepted ? "publishes only after confirmation" : "cancels without preparation"}`, async () => {
    const handlers = new Map(),
      calls = [];
    const requestedRecipe = {
      descriptor: {
        id: "another-public-recipe",
        name: "Requested setup",
        revision: "a".repeat(64),
        slots: [null],
      },
    };
    const manifest = { personalDisks: [{ id: "original", name: "Keep me" }] };
    const candidate = { manifest, newBlobs: new Map() };
    vm.runInNewContext(source.slice(start, end), {
      document: {
        querySelector: (id) => ({
          addEventListener: (_, handler) => handlers.set(id, handler),
        }),
      },
      requestedRecipe,
      libraryRecipe: () => {
        throw new Error("Requested recipe must not resolve a default");
      },
      confirm: (message) => {
        assert.match(message, /Requested setup/);
        assert.match(message, /retained/);
        return accepted;
      },
      libraryBarrier: async () => {
        calls.push("barrier");
        return "barrier";
      },
      store: { head: { manifest } },
      prepareDiskBoxRecipeLaunch: async (head, recipe, options) => {
        assert.equal(head, manifest);
        assert.equal(recipe, requestedRecipe);
        assert.equal(options.freshInstance, false);
        calls.push("prepare");
        return candidate;
      },
      libraryCommit: async (value, barrier, reboot) => {
        assert.equal(value, candidate);
        assert.equal(barrier, "barrier");
        assert.equal(reboot, true);
        calls.push("commit");
      },
      libraryError: (error) => {
        throw error;
      },
    });
    assert(
      handlers.has("#launch-requested"),
      "explicit requested-recipe action is missing",
    );
    await handlers.get("#launch-requested")();
    assert.deepEqual(calls, accepted ? ["barrier", "prepare", "commit"] : []);
    assert.deepEqual(manifest.personalDisks, [
      { id: "original", name: "Keep me" },
    ]);
  });
}
