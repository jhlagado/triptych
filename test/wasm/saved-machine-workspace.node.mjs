import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { createSavedMachineWorkspace } from "../../crates/triptych-host-wasm/web/saved-machine-workspace.js";
import {
  copySavedMachine,
  prepareSavedMachine,
  sameSavedMachine,
} from "../../crates/triptych-host-wasm/web/saved-machine.js";

const legacy = (byte) => ({
  bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256).fill(42) },
  drives: {
    A: { name: "work.img", bytes: new Uint8Array(512).fill(byte) },
    B: null,
  },
});
const machine = (byte, count = 16, sparse = true) => ({
  schema: "triptych-drive-set-v4",
  configuredCount: count,
  bootstrap: {
    profile: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
    bytes: new Uint8Array(256).fill(42),
  },
  slots: Array.from({ length: count }, (_, i) =>
    sparse && i !== 0 && i !== count - 1
      ? null
      : {
          instanceId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
          name: `${i}.img`,
          bytes: new Uint8Array(2097152).fill(byte + i),
        },
  ),
});
const clone = (value) => structuredClone(value);
const byte = (value) => value.slots?.[0].bytes[0] ?? value.drives.A.bytes[0];
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function fixture({ value = legacy(1), historical, empty = false } = {}) {
  const prepared = await prepareSavedMachine(value, webcrypto);
  const historicalToken = historical
    ? { kind: "historical", store: historical, identity: "a".repeat(64) }
    : undefined;
  let head = {
    kind: "ready",
    token: historicalToken ?? {
      kind: "v4",
      revision: 1,
      digest: prepared.digest,
    },
    snapshot: prepared.snapshot,
    ...(historicalToken
      ? {}
      : {
          receipt: {
            authority: "v4",
            revision: 1,
            operationId: "initial",
            digest: prepared.digest,
          },
        }),
  };
  if (empty) head = { kind: "empty", token: { kind: "empty" } };
  let rev = empty ? 0 : historical ? 5 : 1,
    guest = copySavedMachine(value),
    sequence = 0;
  const events = [],
    records = new Map(),
    writer = { owned: true };
  const publish = async (expected, id, value, manual) => {
    const prepared = await prepareSavedMachine(value, webcrypto);
    if (manual && records.has(id)) {
      const old = records.get(id);
      assert.deepEqual(expected, old.expected);
      assert.equal(prepared.digest, old.result.receipt.digest);
      return clone(old.result);
    }
    assert.deepEqual(expected, head.token);
    events.push(`${manual ? "commit" : "save"}:${byte(value)}`);
    rev++;
    const result = {
      token: { kind: "v4", revision: rev, digest: prepared.digest },
      receipt: {
        authority: "v4",
        revision: rev,
        operationId: manual ? id : `checkpoint:${rev}`,
        digest: prepared.digest,
      },
    };
    if (manual)
      records.set(id, {
        expected: clone(expected),
        result: clone(result),
        before: clone(head),
      });
    head = { kind: "ready", ...clone(result), snapshot: prepared.snapshot };
    return result;
  };
  const store = {
    load: async () => clone(head),
    saveCheckpoint: (expected, value) =>
      publish(expected, undefined, value, false),
    commitChange: (expected, id, value) => publish(expected, id, value, true),
  };
  const runtime = {
    pause() {
      events.push("pause");
    },
    resume() {
      events.push("resume");
    },
    ready() {
      return true;
    },
    checkpoint() {
      events.push("capture");
      return copySavedMachine(guest);
    },
    async prepare(value) {
      events.push("prepare");
      return { snapshot: value };
    },
    activate(value) {
      events.push("activate");
      guest = copySavedMachine(value.snapshot);
    },
    discard() {
      events.push("discard");
    },
  };
  const workspace = createSavedMachineWorkspace({
    store,
    writer,
    runtime,
    token: clone(head.token),
    operationId: () => `change-${++sequence}`,
  });
  return {
    workspace,
    store,
    runtime,
    writer,
    events,
    records,
    head: () => clone(head),
    setHead: (value) => {
      head = clone(value);
    },
    guest: () => copySavedMachine(guest),
  };
}
const begin = (f) => f.workspace.beginManagement({ savedAndExited: true });

for (const historical of ["working-disks", "disk-revisions", "drive-set-state"])
  test(`historical ${historical} identity is retained until acknowledged publication`, async () => {
    const f = await fixture({ historical });
    const initial = f.workspace.token;
    assert.deepEqual(initial, {
      kind: "historical",
      store: historical,
      identity: "a".repeat(64),
    });
    const result = await f.workspace.saveCheckpoint(legacy(2));
    assert.equal(result.kind, "saved");
    assert.equal(result.token.kind, "v4");
    assert.equal(result.token.revision, 6);
    assert.deepEqual(f.workspace.token, result.token);
    assert.equal(result.receipt.authority, "v4");
    const token = await begin(f);
    f.workspace.stage(token, legacy(3));
    const published = await f.workspace.commit(token);
    assert.deepEqual(Object.keys(published).sort(), ["receipt", "token"]);
    assert.equal(published.token.revision, 8);
    assert.equal(byte(f.guest()), 3);
  });

test("v3-shaped media under v4 authority never chooses the legacy token protocol", async () => {
  const f = await fixture();
  assert.equal(f.head().snapshot.schema, undefined);
  assert.equal(f.workspace.token.kind, "v4");
  const token = await begin(f);
  f.workspace.stage(token, legacy(4));
  const result = await f.workspace.commit(token);
  assert.deepEqual(f.workspace.token, result.token);
  assert.equal(result.receipt.authority, "v4");
  assert.equal(byte(f.guest()), 4);
});

test("sparse A/P preserves configured count, identity and all payloads through publication", async () => {
  const f = await fixture({ value: machine(1) }),
    token = await begin(f),
    candidate = machine(3);
  f.workspace.stage(token, candidate);
  candidate.slots[15].bytes[2097151] = 99;
  candidate.slots[0].instanceId = "changed";
  candidate.bootstrap.bytes[255] = 0;
  await f.workspace.commit(token);
  assert(sameSavedMachine(f.guest(), machine(3)));
  assert.equal(f.guest().slots.length, 16);
  assert.equal(f.guest().slots[1], null);
});

test("all sixteen occupied media checkpoint with independent mutation-isolated payloads", async () => {
  const f = await fixture(),
    value = machine(1, 16, false);
  const pending = f.workspace.saveCheckpoint(value);
  value.slots[15].bytes.fill(99);
  value.slots[0].name = "changed";
  const saved = await pending;
  assert.equal(saved.token.kind, "v4");
  assert(sameSavedMachine(f.head().snapshot, machine(1, 16, false)));
  const token = f.workspace.token;
  token.digest = "0".repeat(64);
  assert.notEqual(f.workspace.token.digest, token.digest);
});

test("new management captures its baseline only after both accepted autosaves drain", async () => {
  const f = await fixture(),
    started = deferred(),
    wait = deferred(),
    save = f.store.saveCheckpoint;
  let calls = 0;
  f.store.saveCheckpoint = async (...args) => {
    if (++calls === 1) {
      started.resolve();
      await wait.promise;
    }
    return save(...args);
  };
  const first = f.workspace.saveCheckpoint(legacy(2));
  await started.promise;
  const latest = f.workspace.saveCheckpoint(legacy(3));
  const management = begin(f);
  assert.deepEqual(f.events, ["pause"]);
  await assert.rejects(
    f.workspace.saveCheckpoint(legacy(4)),
    /gates autosaves/,
  );
  wait.resolve();
  await Promise.all([first, latest, management]);
  assert.deepEqual(f.events, [
    "pause",
    "save:2",
    "save:3",
    "capture",
    "save:1",
  ]);
  assert.equal(calls, 3);
  assert.equal(f.workspace.state, "managing");
});

test("new autosaves retain only first and latest jobs; superseded is not a receipt", async () => {
  const f = await fixture(),
    started = deferred(),
    wait = deferred(),
    save = f.store.saveCheckpoint;
  let calls = 0;
  f.store.saveCheckpoint = async (...args) => {
    if (++calls === 1) {
      started.resolve();
      await wait.promise;
    }
    return save(...args);
  };
  const first = f.workspace.saveCheckpoint(legacy(2));
  await started.promise;
  const waiting = [];
  for (let i = 3; i < 103; i++) {
    const source = legacy(i);
    waiting.push(f.workspace.saveCheckpoint(source));
    source.drives.A.bytes.fill(255);
  }
  assert.deepEqual(
    await Promise.all(waiting.slice(0, -1)),
    Array.from({ length: 99 }, () => ({ kind: "superseded" })),
  );
  wait.resolve();
  const [a, b] = await Promise.all([first, waiting.at(-1)]);
  assert.equal(a.kind, "saved");
  assert.equal(b.kind, "saved");
  assert.equal(calls, 2);
  assert.equal(byte(f.head().snapshot), 102);
  assert.deepEqual(b.token, f.workspace.token);
});

test("failed save keeps only newest retry and adopts no unacknowledged token", async () => {
  const f = await fixture(),
    started = deferred(),
    wait = deferred(),
    save = f.store.saveCheckpoint,
    token = f.workspace.token;
  f.store.saveCheckpoint = async () => {
    started.resolve();
    await wait.promise;
    throw Error("quota");
  };
  const first = f.workspace.saveCheckpoint(legacy(2));
  await started.promise;
  const superseded = f.workspace.saveCheckpoint(legacy(3)),
    latest = f.workspace.saveCheckpoint(legacy(4));
  const rejected = Promise.allSettled([first, latest]);
  assert.deepEqual(await superseded, { kind: "superseded" });
  wait.resolve();
  assert((await rejected).every((x) => x.status === "rejected"));
  assert.deepEqual(f.workspace.token, token);
  f.store.saveCheckpoint = save;
  const result = await f.workspace.retryCheckpoint();
  assert.equal(result.kind, "saved");
  assert.equal(byte(f.head().snapshot), 4);
  assert.equal(f.workspace.retryCheckpoint(), undefined);
});

for (const malformed of [
  { kind: "legacy", identity: "a".repeat(64) },
  { kind: "v3", revision: 1 },
  { kind: "v4", revision: 1, digest: "bad" },
  { kind: "v4", revision: 1, digest: "a".repeat(64), extra: true },
  { kind: "historical", store: "unknown", identity: "a".repeat(64) },
  { kind: "empty", extra: true },
])
  test(`new coordinator rejects malformed or legacy-protocol token ${JSON.stringify(malformed)}`, () => {
    assert.throws(() => createSavedMachineWorkspace({ token: malformed }));
  });

for (const fault of [
  "missing-token",
  "extra-field",
  "wrong-authority",
  "wrong-revision",
  "wrong-digest",
  "legacy-token",
  "receipt-extra",
])
  test(`checkpoint publication rejects ${fault} without adopting a fabricated authority token`, async () => {
    const f = await fixture(),
      old = f.workspace.token,
      save = f.store.saveCheckpoint;
    f.store.saveCheckpoint = async (...args) => {
      const result = await save(...args);
      if (fault === "missing-token") delete result.token;
      if (fault === "extra-field") result.extra = 1;
      if (fault === "wrong-authority") result.receipt.authority = "v5";
      if (fault === "wrong-revision") result.receipt.revision++;
      if (fault === "wrong-digest") result.token.digest = "0".repeat(64);
      if (fault === "legacy-token")
        result.token = { kind: "v3", revision: result.receipt.revision };
      if (fault === "receipt-extra") result.receipt.extra = true;
      return result;
    };
    await assert.rejects(f.workspace.saveCheckpoint(legacy(2)));
    assert.deepEqual(f.workspace.token, old);
  });

test("lost publication response recovers and same-operation retry converges", async () => {
  const f = await fixture(),
    token = await begin(f),
    commit = f.store.commitChange;
  f.workspace.stage(token, legacy(2));
  f.store.commitChange = async (...args) => {
    await commit(...args);
    throw Error("lost reply");
  };
  await assert.rejects(f.workspace.commit(token), /lost reply/);
  assert.equal(f.workspace.state, "recovery");
  assert.equal(f.events.includes("activate"), false);
  f.store.commitChange = commit;
  const result = await f.workspace.commit(token);
  assert.equal(result.token.revision, 3);
  assert.equal(f.records.size, 1);
  assert.equal(f.workspace.state, "running");
});

test("valid old receipt cannot activate over a newer head", async () => {
  const f = await fixture(),
    token = await begin(f),
    commit = f.store.commitChange;
  f.workspace.stage(token, legacy(2));
  f.store.commitChange = async (...args) => {
    const old = await commit(...args);
    await f.store.saveCheckpoint(old.token, legacy(9));
    return old;
  };
  await assert.rejects(f.workspace.commit(token), /Committed disk changed/);
  assert.equal(f.workspace.state, "recovery");
  assert.equal(f.events.includes("activate"), false);
  assert.equal(byte(f.head().snapshot), 9);
  f.store.commitChange = commit;
  await assert.rejects(f.workspace.commit(token), /Committed disk changed/);
  assert.equal(f.events.includes("activate"), false);
});

test("historical recovery baseline retains store identity and never exports unsafe live state", async () => {
  const f = await fixture({ historical: "disk-revisions" });
  f.runtime.checkpoint = () => {
    throw Error("unsafe export");
  };
  f.runtime.ready = () => false;
  const token = await f.workspace.beginRecovery({ discardVolatile: true });
  assert.deepEqual(f.workspace.inspect(token).token, {
    kind: "historical",
    store: "disk-revisions",
    identity: "a".repeat(64),
  });
  f.workspace.stage(token, legacy(3));
  const result = await f.workspace.commit(token);
  assert.equal(result.token.revision, 6);
  assert.equal(byte(f.guest()), 3);
});

test("a receipt for another historical source cannot activate a newer saved head", async () => {
  const f = await fixture({ historical: "working-disks" }),
    token = await f.workspace.beginRecovery({ discardVolatile: true });
  f.workspace.stage(token, legacy(3));
  const commit = f.store.commitChange;
  f.store.commitChange = async (...args) => {
    const old = await commit(...args);
    await f.store.saveCheckpoint(old.token, legacy(9));
    return old;
  };
  await assert.rejects(f.workspace.commit(token), /Committed disk changed/);
  assert.equal(f.workspace.state, "recovery");
  assert.equal(f.events.includes("activate"), false);
});

test("runtime admission failure publishes no candidate and allows cancellation", async () => {
  const f = await fixture(),
    token = await begin(f),
    before = f.head();
  f.workspace.stage(token, machine(1));
  f.runtime.prepare = async () => {
    throw Error("profile unavailable");
  };
  await assert.rejects(f.workspace.commit(token), /profile unavailable/);
  assert.deepEqual(f.head(), before);
  assert.equal(f.records.size, 0);
  assert.equal(f.workspace.state, "managing");
  f.workspace.cancel(token);
  assert.equal(f.workspace.state, "running");
});

test("close during preparation disposes candidate and never publishes or resumes", async () => {
  const f = await fixture(),
    token = await begin(f),
    waiting = deferred(),
    before = f.head();
  f.workspace.stage(token, legacy(2));
  f.runtime.prepare = () => waiting.promise;
  const pending = f.workspace.commit(token);
  await f.workspace.close();
  waiting.resolve({ snapshot: legacy(2) });
  await assert.rejects(pending);
  assert.deepEqual(f.head(), before);
  assert.equal(f.workspace.state, "closed");
  assert.equal(f.events.includes("discard"), true);
  assert.equal(f.events.includes("activate"), false);
});

test("activation failure remains stopped with durable recovery and no ambiguous disposal", async () => {
  const f = await fixture(),
    token = await begin(f);
  f.workspace.stage(token, legacy(2));
  f.runtime.activate = () => {
    throw Error("activation failed");
  };
  await assert.rejects(f.workspace.commit(token), /activation failed/);
  assert.equal(f.workspace.state, "recovery");
  assert.equal(f.workspace.recovery.receipt.authority, "v4");
  assert.equal(byte(f.head().snapshot), 2);
  assert.equal(f.events.includes("discard"), false);
  assert.equal(f.events.includes("resume"), false);
});

test("close drains active save, rejects pending and never captures management baseline", async () => {
  const f = await fixture(),
    started = deferred(),
    waiting = deferred(),
    save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async (...args) => {
    started.resolve();
    await waiting.promise;
    return save(...args);
  };
  const first = f.workspace.saveCheckpoint(legacy(2));
  await started.promise;
  const management = begin(f);
  const rejected = assert.rejects(management, /Superseded/);
  const closing = f.workspace.close();
  waiting.resolve();
  await Promise.all([first, closing, rejected]);
  assert.equal(f.events.includes("capture"), false);
  assert.equal(f.workspace.state, "closed");
});

test("ownership loss while draining prevents baseline capture and publication", async () => {
  const f = await fixture(),
    started = deferred(),
    waiting = deferred(),
    save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async (...args) => {
    started.resolve();
    await waiting.promise;
    return save(...args);
  };
  const first = f.workspace.saveCheckpoint(legacy(2));
  await started.promise;
  const management = begin(f);
  const denied = assert.rejects(management, /read-only/);
  f.writer.owned = false;
  waiting.resolve();
  await Promise.all([first, denied]);
  assert.equal(f.events.includes("capture"), false);
  assert.equal(f.workspace.state, "running");
});
