import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  copySavedMachine,
  sameSavedMachine,
} from "../../crates/triptych-host-wasm/web/saved-machine.js";

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
  "copyDiskBoxView",
  "initial",
  `${between("let committed;", "let lastFlushCounts")}
  committed = initial;
  ${between("async function refreshCommitted()", "\nasync function rawRecovery()")}
  ${between("  const coordinatedStore = {", "  workspace = createDiskBoxArchiveWorkspace({")}
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
  token: { kind: "disk-box", revision, digest: "a".repeat(64) },
  snapshot: snapshot(revision),
});
function deferred() {
  let resolve;
  const promise = new Promise((yes) => (resolve = yes));
  return { promise, resolve };
}

const requireExactPublication = new Function(
  "sameDiskBoxView",
  `${between("function requireExactPublication(", "\ntry {\n  const route =")}; return requireExactPublication;`,
)(sameSavedMachine);
test("CPU activation requires the exact acknowledged durable publication", () => {
  const receipt = {
    revision: 3,
    digest: "a".repeat(64),
    operationId: "accepted",
  };
  const loaded = { ...ready(3), receipt };
  const publication = { status: "committed", token: loaded.token, receipt };
  assert.doesNotThrow(() =>
    requireExactPublication(publication, loaded, loaded.snapshot),
  );
  for (const changed of [
    { ...publication, status: "superseded" },
    { ...publication, token: { ...publication.token, revision: 2 } },
    { ...publication, token: { ...publication.token, digest: "b".repeat(64) } },
    { ...publication, receipt: { ...receipt, operationId: "other" } },
  ])
    assert.throws(
      () => requireExactPublication(changed, loaded, loaded.snapshot),
      /authority changed/,
    );
  assert.throws(
    () =>
      requireExactPublication(
        publication,
        { kind: "recovery" },
        loaded.snapshot,
      ),
    /authority changed/,
  );
  assert.throws(
    () => requireExactPublication(publication, loaded, snapshot(99)),
    /authority changed/,
  );
});

const adapterSource = await readFile(
  new URL(
    "../../crates/triptych-host-wasm/web/disk-box-app-store.js",
    import.meta.url,
  ),
  "utf8",
);
function adapterBetween(first, last) {
  const start = adapterSource.indexOf(first),
    end = adapterSource.indexOf(last, start);
  assert(
    start >= 0 && end > start,
    `Missing adapter source boundary: ${first}`,
  );
  return adapterSource.slice(start, end);
}
const adapterHarness = new Function(
  "authority",
  "snapshotFor",
  "initial",
  `
  let head = initial, headGeneration = 0;
  ${adapterBetween("  async function load()", "  function config()")}
  return { load, current: () => head, publish(value) { ++headGeneration; head = value; } };
`,
);
for (const phase of ["authority", "bytes", "receipt"]) {
  test(`adapter ${phase} read cannot overwrite a newer published head`, async () => {
    const wait = deferred();
    const old = { ...ready(3), manifest: { revision: 3 } };
    const newer = { ...ready(4), manifest: { revision: 4 } };
    const receipt = {
      revision: 3,
      digest: old.token.digest,
      operationId: "old",
    };
    const adapter = adapterHarness(
      {
        load: () =>
          phase === "authority" ? wait.promise : Promise.resolve(old),
        readRawRecovery: () =>
          phase === "receipt" ? wait.promise : Promise.resolve(receipt),
      },
      () => (phase === "bytes" ? wait.promise : Promise.resolve(old.snapshot)),
      old,
    );
    const pending = adapter.load();
    // Allow each asynchronous stage to enter before acknowledging publication.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    adapter.publish(newer);
    wait.resolve(
      phase === "authority" ? old : phase === "bytes" ? old.snapshot : receipt,
    );
    assert.equal((await pending).kind, "recovery");
    assert.deepEqual(adapter.current(), newer);
  });
}

test("adapter only adopts an uncontested fully resolved head", async () => {
  const value = { ...ready(3), manifest: { revision: 3 } };
  const wait = deferred();
  const adapter = adapterHarness(
    {
      load: async () => value,
      readRawRecovery: async () => ({
        revision: 3,
        digest: value.token.digest,
        operationId: "ok",
      }),
    },
    () => wait.promise,
    undefined,
  );
  const loading = adapter.load();
  await Promise.resolve();
  assert.equal(adapter.current(), undefined);
  wait.resolve(value.snapshot);
  assert.equal((await loading).kind, "ready");
  assert.deepEqual(adapter.current(), value);
});

test("adapter preparation uses one owned manifest across asynchronous resolution", async () => {
  const oldManifest = {
    selectedConfigurationId: "original",
    configurations: [{ id: "original", slots: [null] }],
    personalDisks: [],
  };
  const wait = deferred();
  const value = {
    schema: "triptych-drive-set-v4",
    configuredCount: 1,
    bootstrap: {
      profile: "triptych-cpu-v0.1-2m-n01",
      bytes: new Uint8Array(256),
    },
    slots: [null],
  };
  const make = new Function(
    "snapshotFor",
    "copyDiskBoxView",
    "initial",
    `
    let head = initial;
    const validateDiskBoxManifest = structuredClone;
    const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
    const media = (snapshot) => snapshot.slots;
    const hash = async () => { throw new Error('empty slots need no hash'); };
    const prepareDiskBoxCheckpoint = async (manifest, id) => ({ manifest, id });
    ${adapterBetween("  async function prepareView(", "  async function publish(")}
    return { prepareView, replace(value) { head = value; } };
  `,
  );
  const adapter = make(() => wait.promise, structuredClone, {
    kind: "ready",
    manifest: oldManifest,
  });
  const pending = adapter.prepareView(value, true);
  oldManifest.configurations[0].id = "caller-mutated";
  adapter.replace({
    kind: "ready",
    manifest: { configurations: [], personalDisks: [] },
  });
  wait.resolve(value);
  const candidate = await pending;
  assert.equal(candidate.id, "original");
  assert.equal(candidate.manifest.configurations[0].id, "original");
  assert.deepEqual(candidate.slotWritable, [false]);
});

for (const oldResult of [
  ready(3),
  { kind: "recovery", error: "old read failed" },
]) {
  test(`a delayed ${oldResult.kind} load cannot replace a newer acknowledged save`, async () => {
    const wait = deferred();
    const receipt = {
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
