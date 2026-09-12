import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(
  new URL("../../crates/triptych-host-wasm/web/app.js", import.meta.url),
  "utf8",
);
const start = source.indexOf("async function rawRecovery()"),
  end = source.indexOf("\nfunction connectWorkspace()", start);
assert(start >= 0 && end > start);
const make = new Function(
  "store",
  "document",
  "button",
  "download",
  `${source.slice(start, end)}; return rawRecovery;`,
);

test("raw recovery exposes stable disk IDs and unvalidated bytes even in a malformed box head", async () => {
  const diskId = "00000000-0000-4000-8000-000000000012",
    bytes = new Uint8Array([4, 9, 1]);
  const head = {
    manifest: {
      schema: "corrupt-schema",
      personalDisks: [
        null,
        { id: 7 },
        {
          id: diskId,
          name: "My old disk",
          content: { sha256: "not-a-valid-hash" },
        },
      ],
    },
  };
  const reads = [],
    entries = [],
    downloads = [];
  const recovery = make(
    {
      readRawRecovery: async (store, key) => {
        reads.push([store, key]);
        if (store === "disk-box-state-v1") return head;
        if (store === "disk-box-blobs-v1") return { bytes };
        return undefined;
      },
    },
    {
      querySelector: () => ({
        replaceChildren() {
          entries.length = 0;
        },
        append(entry) {
          entries.push(entry);
        },
      }),
    },
    (label, action) => ({ label, action, dataset: {} }),
    (bytes, name) => downloads.push({ bytes, name }),
  );
  await recovery();
  const disk = entries.find((entry) => entry.dataset.recoveryDiskId === diskId);
  assert.equal(disk.label, "Download raw My old disk");
  disk.action();
  assert.equal(downloads[0].bytes, bytes);
  assert.equal(downloads[0].name, `recovery-${diskId}.img`);
  assert(
    reads.some(
      ([store, key]) =>
        store === "disk-box-blobs-v1" && key === "not-a-valid-hash",
    ),
  );
  entries
    .find((entry) => entry.label === "Download raw disk-box manifest")
    .action();
  assert.deepEqual(
    JSON.parse(new TextDecoder().decode(downloads[1].bytes)),
    head,
  );
  assert.equal(
    reads.some(([store]) => store === "published"),
    false,
  );
});

test("a malformed personal-disk collection still leaves the raw manifest downloadable", async () => {
  const entries = [];
  const recovery = make(
    {
      readRawRecovery: async (store) =>
        store === "disk-box-state-v1"
          ? { manifest: { personalDisks: "corrupt" } }
          : undefined,
    },
    {
      querySelector: () => ({
        replaceChildren() {},
        append(entry) {
          entries.push(entry);
        },
      }),
    },
    (label, action) => ({ label, action, dataset: {} }),
    () => {},
  );
  await recovery();
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ["Download raw disk-box manifest"],
  );
});
