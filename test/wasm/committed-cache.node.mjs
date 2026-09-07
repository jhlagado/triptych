import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { copySavedMachine } from "../../crates/triptych-host-wasm/web/saved-machine.js";

// Exercise the actual app functions without a DOM, WASM build or browser server.
// Source boundaries fail explicitly if the app moves these functions; no copied
// implementation of cache adoption is used as the regression oracle.
const source = await readFile(
  new URL("../../crates/triptych-host-wasm/web/app.js", import.meta.url),
  "utf8",
);
function between(first, last) {
  const start = source.indexOf(first);
  const end = source.indexOf(last, start);
  assert(start >= 0 && end > start, `Missing app source boundary: ${first}`);
  return source.slice(start, end);
}
const createHarness = new Function(
  "store",
  "copySavedMachine",
  "initial",
  `${between("let committed;", "let lastFlushCounts")}
  committed = initial;
  ${between("async function refreshCommitted()", "\nasync function rawRecovery()")}
  ${between("  const coordinatedStore = {", "  workspace = createSavedMachineWorkspace({")}
  return { refreshCommitted, coordinatedStore, current: () => committed };`,
);
const snapshot = (byte) => ({
  bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256).fill(42) },
  drives: {
    A: { name: "work.img", bytes: new Uint8Array(512).fill(byte) },
    B: null,
  },
});
const ready = (revision) => ({
  kind: "ready",
  token: { kind: "v4", revision, digest: "a".repeat(64) },
  snapshot: snapshot(revision),
});
function deferred() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

for (const oldResult of [
  ready(3),
  { kind: "recovery", error: "old read failed" },
]) {
  test(`a delayed ${oldResult.kind} load cannot replace a newer acknowledged save`, async () => {
    const wait = deferred();
    const receipt = {
      authority: "v4",
      revision: 4,
      operationId: "save-4",
      digest: "a".repeat(64),
    };
    const publication = { token: ready(4).token, receipt };
    const app = createHarness(
      {
        load: () => wait.promise,
        saveCheckpoint: async () => publication,
      },
      copySavedMachine,
      ready(3),
    );
    const loading = app.refreshCommitted();
    const value = snapshot(4);
    await app.coordinatedStore.saveCheckpoint(ready(3).token, value);
    value.drives.A.bytes.fill(9);
    wait.resolve(oldResult);
    assert.deepEqual(await loading, oldResult);
    assert.equal(app.current()?.token.revision, 4);
    assert.deepEqual(app.current().token, publication.token);
    assert.equal(app.current().snapshot.drives.A.bytes[0], 4);
    assert.deepEqual(app.current().receipt, receipt);
  });
}

test("an uncontested refresh still adopts its saved state or recovery result", async () => {
  for (const result of [ready(4), { kind: "recovery", error: "bad head" }]) {
    const app = createHarness(
      { load: async () => result },
      copySavedMachine,
      ready(3),
    );
    assert.deepEqual(await app.refreshCommitted(), result);
    assert.deepEqual(
      app.current(),
      result.kind === "ready" ? result : undefined,
    );
  }
});

test("a sparse sixteen-slot save captures identities and every medium before yielding", async () => {
  const pending = deferred();
  const value = {
    schema: "triptych-drive-set-v4",
    configuredCount: 16,
    bootstrap: {
      profile: "triptych-cpu-v0.1-2m-n16",
      bytes: new Uint8Array(256).fill(42),
    },
    slots: Array.from({ length: 16 }, (_, index) =>
      [0, 15].includes(index)
        ? {
            instanceId:
              index === 0
                ? "00000000-0000-4000-8000-00000000000a"
                : "00000000-0000-4000-8000-00000000000f",
            name: `${index}.img`,
            bytes: new Uint8Array(2097152).fill(index),
          }
        : null,
    ),
  };
  const expected = copySavedMachine(value);
  const publication = {
    token: ready(4).token,
    receipt: {
      authority: "v4",
      revision: 4,
      operationId: "checkpoint:4",
      digest: "a".repeat(64),
    },
  };
  let submitted;
  const app = createHarness(
    {
      saveCheckpoint: async (_token, snapshot) => {
        submitted = snapshot;
        return pending.promise;
      },
    },
    copySavedMachine,
    ready(3),
  );
  const saving = app.coordinatedStore.saveCheckpoint(ready(3).token, value);
  value.slots[15].bytes.fill(99);
  value.slots[15].instanceId = "changed-after-submit";
  value.bootstrap.bytes.fill(7);
  pending.resolve(publication);
  await saving;
  assert.deepEqual(submitted, expected);
  assert.deepEqual(app.current().snapshot, expected);
  assert.deepEqual(app.current().token, publication.token);
});

test("an older overlapping refresh cannot undo an already adopted newer refresh", async () => {
  const first = deferred();
  let calls = 0;
  const latest = ready(4);
  const app = createHarness(
    {
      load: () => (++calls === 1 ? first.promise : Promise.resolve(latest)),
    },
    copySavedMachine,
    ready(3),
  );
  const older = app.refreshCommitted();
  await app.refreshCommitted();
  first.resolve(ready(3));
  await older;
  assert.equal(app.current().token.revision, latest.token.revision);
  assert.equal(app.current().snapshot.drives.A.bytes[0], 4);
});

test("a newer overlapping refresh is still adopted when the older one resolves first", async () => {
  const first = deferred(),
    second = deferred();
  let calls = 0;
  const app = createHarness(
    { load: () => (++calls === 1 ? first.promise : second.promise) },
    copySavedMachine,
    ready(2),
  );
  const older = app.refreshCommitted(),
    newer = app.refreshCommitted();
  first.resolve(ready(3));
  await older;
  second.resolve(ready(4));
  await newer;
  assert.equal(app.current().token.revision, 4);
  assert.equal(app.current().snapshot.drives.A.bytes[0], 4);
});

test("a delayed backup download retains the drive selected at click time", async () => {
  const createDownload = new Function(
    "readBackup",
    "download",
    "backup",
    `let selectedDrive = "A";
    ${between("function driveIndex(", "function replaceImage(")}
    const button = (_label, action) => action;
    const handler = ${between('button("Download backup", async () => {', '\n        button("Download set",').trim().replace(/,$/, "")};
    return { handler, select: (value) => { selectedDrive = value; } };`,
  );
  const waiting = deferred();
  const downloads = [];
  const app = createDownload(
    () => waiting.promise,
    (...args) => downloads.push(args),
    { id: "v3:change", revision: 3 },
  );
  const action = app.handler();
  app.select("B");
  waiting.resolve({
    drives: {
      A: { name: "a.img", bytes: Uint8Array.of(0xaa) },
      B: { name: "b.img", bytes: Uint8Array.of(0xbb) },
    },
  });
  await action;
  assert.deepEqual(downloads, [[Uint8Array.of(0xaa), "backup-r3-a.img"]]);
});
