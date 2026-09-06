import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  acquireDiskWriter,
  createDiskWorkspace,
} from "../../crates/triptych-host-wasm/web/disk-workspace.js";

const disk = (byte) => ({
  bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256).fill(42) },
  drives: {
    A: { name: "work.img", bytes: new Uint8Array(512).fill(byte) },
    B: null,
  },
});
const driveSet = (a, b) => ({
  bootstrap: {
    profile: "triptych-cpu-v0.1-8m-ab",
    bytes: new Uint8Array(256).fill(42),
  },
  drives: {
    A: { name: "a.img", bytes: new Uint8Array(8388608).fill(a) },
    B:
      b === null
        ? null
        : { name: "b.img", bytes: new Uint8Array(8388608).fill(b) },
  },
});
const clone = (value) => value && structuredClone(value);
const snapshot = (value) =>
  clone({ bootstrap: value.bootstrap, drives: value.drives });
const digest = (value) => {
  const hash = createHash("sha256")
    .update(value.bootstrap.profile)
    .update(value.bootstrap.bytes);
  for (const drive of [value.drives.A, value.drives.B]) {
    hash.update(drive ? drive.name : "absent");
    if (drive) hash.update(drive.bytes);
  }
  return hash.digest("hex");
};
const receipt = (value) => ({
  revision: value.revision,
  operationId: value.operationId,
  digest: digest(value),
});
const loaded = (value) =>
  value && {
    kind: "ready",
    token: { kind: "v3", revision: value.revision },
    snapshot: snapshot(value),
    receipt: receipt(value),
  };
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const events = [];
  const writer = { owned: true };
  let head = { ...disk(0), revision: 1, operationId: "initial" };
  let guest = disk(1);
  let sequence = 0;
  const changes = new Map();
  const store = {
    async load() {
      return loaded(head);
    },
    async saveCheckpoint(expected, value) {
      events.push(`save:${value.drives.A.bytes[0]}`);
      assert.deepEqual(expected, { kind: "v3", revision: head.revision });
      head = {
        ...clone(value),
        revision: expected.revision + 1,
        operationId: `checkpoint:${expected.revision + 1}`,
      };
      return receipt(head);
    },
    async commitChange(expected, operationId, value) {
      events.push(`commit:${value.drives.A.bytes[0]}`);
      const previous = changes.get(operationId);
      if (previous) {
        assert.deepEqual(expected, {
          kind: "v3",
          revision: previous.before.revision,
        });
        assert.deepEqual(value, snapshot(previous.after));
        return receipt(previous.after);
      }
      assert.deepEqual(expected, { kind: "v3", revision: head.revision });
      const before = clone(head);
      head = { ...clone(value), revision: expected.revision + 1, operationId };
      changes.set(operationId, { before, after: clone(head) });
      return receipt(head);
    },
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
      return clone(guest);
    },
    async prepare(value) {
      events.push(`prepare:${value.drives.A.bytes[0]}`);
      return { disk: value };
    },
    activate(value) {
      events.push(`activate:${value.disk.drives.A.bytes[0]}`);
      guest = clone(value.disk);
    },
    discard(value) {
      events.push(`discard:${value.disk.drives.A.bytes[0]}`);
    },
  };
  const workspace = createDiskWorkspace({
    store,
    writer,
    runtime,
    token: { kind: "v3", revision: 1 },
    operationId: () => `change-${++sequence}`,
  });
  return {
    workspace,
    store,
    writer,
    runtime,
    events,
    changes,
    head: () => clone(head),
    setHead: (value) => {
      head = clone(value);
    },
  };
}
const enter = (f) => f.workspace.beginManagement({ savedAndExited: true });
const recoverSaved = (f) =>
  f.workspace.beginRecovery({ discardVolatile: true });

test("explicit recovery uses the exact saved disk without inspecting an unsafe guest", async () => {
  const f = fixture();
  f.runtime.ready = f.runtime.checkpoint = () => {
    assert.fail("Recovery must not inspect or export unsafe live guest state");
  };
  const token = await recoverSaved(f);
  assert.equal(f.workspace.state, "managing");
  assert.equal(f.workspace.canRun, false);
  assert.deepEqual(f.workspace.inspect(token), {
    snapshot: disk(0),
    token: { kind: "v3", revision: 1 },
    operationId: "change-1",
  });
  f.workspace.inspect(token).snapshot.drives.A.bytes.fill(9);
  assert.equal(f.workspace.inspect(token).snapshot.drives.A.bytes[0], 0);
  assert.deepEqual(f.events, ["pause"]);
  f.workspace.stage(token, disk(2));
  await f.workspace.commit(token);
  assert.deepEqual(f.events, [
    "pause",
    "prepare:2",
    "commit:2",
    "activate:2",
    "resume",
  ]);
  assert.equal(f.changes.get("change-1").before.drives.A.bytes[0], 0);
  assert.equal(f.workspace.token.revision, 2);
});

test("recovery requires exact discard consent and exclusive ownership before pausing", async () => {
  const f = fixture();
  for (const discardVolatile of [undefined, false, 1, "true"])
    await assert.rejects(
      f.workspace.beginRecovery({ discardVolatile }),
      /discard/i,
    );
  f.writer.owned = false;
  await assert.rejects(recoverSaved(f), /read-only/);
  assert.deepEqual(f.events, []);
  assert.equal(f.workspace.canRun, true);
});

test("recovery drains accepted autosaves before loading its durable baseline", async () => {
  const f = fixture();
  const wait = deferred();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async (...args) => {
    await wait.promise;
    return save(...args);
  };
  const load = f.store.load;
  f.store.load = async () => {
    f.events.push("load");
    return load();
  };
  const one = f.workspace.saveCheckpoint(disk(2));
  const two = f.workspace.saveCheckpoint(disk(3));
  const beginning = recoverSaved(f);
  assert.equal(f.workspace.canRun, false);
  await assert.rejects(f.workspace.saveCheckpoint(disk(4)), /gates autosaves/);
  assert.deepEqual(f.events, ["pause"]);
  wait.resolve();
  await Promise.all([one, two]);
  const token = await beginning;
  assert.deepEqual(f.events, ["pause", "save:2", "save:3", "load"]);
  assert.equal(f.workspace.inspect(token).token.revision, 3);
  assert.equal(f.workspace.inspect(token).snapshot.drives.A.bytes[0], 3);
  f.workspace.cancel(token);
  assert.equal(f.workspace.canRun, true);
  assert.equal(f.head().revision, 3);
  assert.equal(f.events.at(-1), "resume");
});

test("recovery clears failed pending autosaves so they cannot overwrite the saved baseline", async () => {
  const f = fixture();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async () => {
    throw new Error("quota");
  };
  await assert.rejects(f.workspace.saveCheckpoint(disk(9)), /quota/);
  f.store.saveCheckpoint = save;
  const token = await recoverSaved(f);
  f.workspace.cancel(token);
  await f.workspace.retryCheckpoint();
  assert.equal(f.head().drives.A.bytes[0], 0);
  assert.equal(f.head().revision, 1);
  assert.deepEqual(f.events, ["pause", "resume"]);
});

test("recovery adopts a durably saved revision after its autosave response was lost", async () => {
  const f = fixture();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async (...args) => {
    await save(...args);
    throw new Error("lost acknowledgment");
  };
  await assert.rejects(
    f.workspace.saveCheckpoint(disk(7)),
    /lost acknowledgment/,
  );
  assert.equal(f.workspace.token.revision, 1);
  const token = await recoverSaved(f);
  assert.equal(f.workspace.inspect(token).token.revision, 2);
  assert.equal(f.workspace.inspect(token).snapshot.drives.A.bytes[0], 7);
  f.workspace.stage(token, disk(2));
  await f.workspace.commit(token);
  assert.equal(f.workspace.token.revision, 3);
  assert.equal(f.changes.get("change-1").before.drives.A.bytes[0], 7);
  assert.equal(f.head().drives.A.bytes[0], 2);
});

test("failed recovery load resumes intact and retains an earlier checkpoint for retry", async () => {
  const f = fixture();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async () => {
    throw new Error("quota");
  };
  await assert.rejects(f.workspace.saveCheckpoint(disk(9)), /quota/);
  f.store.saveCheckpoint = save;
  f.store.load = async () => {
    throw new Error("read failed");
  };
  await assert.rejects(recoverSaved(f), /read failed/);
  assert.equal(f.workspace.canRun, true);
  assert.equal(f.workspace.token.revision, 1);
  await f.workspace.retryCheckpoint();
  assert.equal(f.head().drives.A.bytes[0], 9);
  assert.deepEqual(f.events, ["pause", "resume", "save:9"]);
});

test("recovery rejects missing or malformed saved heads and resumes without writing", async () => {
  for (const head of [
    undefined,
    { ...disk(0), revision: 0 },
    { ...disk(0), revision: 1.5 },
    { ...disk(0), revision: Number.MAX_SAFE_INTEGER + 1 },
    {
      ...disk(0),
      revision: 1,
      drives: { A: { name: "", bytes: new Uint8Array(512) }, B: null },
    },
    {
      ...disk(0),
      revision: 1,
      drives: { A: { name: "bad", bytes: new Uint8Array(3) }, B: null },
    },
  ]) {
    const f = fixture();
    f.setHead(head);
    await assert.rejects(recoverSaved(f), /drive.set|snapshot/i);
    assert.equal(f.workspace.canRun, true);
    assert.deepEqual(f.events, ["pause", "resume"]);
  }
});

test("recovery does not resume or create a session after close during saved-head loading", async () => {
  const f = fixture();
  const wait = deferred();
  f.store.load = () => wait.promise;
  const beginning = recoverSaved(f);
  await Promise.resolve();
  const closing = f.workspace.close();
  wait.resolve(loaded(f.head()));
  await assert.rejects(beginning, /Superseded/);
  await closing;
  assert.equal(f.workspace.state, "closed");
  assert.equal(f.workspace.canRun, false);
  assert.deepEqual(f.events, ["pause", "pause"]);
});

test("recovery rechecks ownership after saved-head loading", async () => {
  const f = fixture();
  const wait = deferred();
  f.store.load = () => wait.promise;
  const beginning = recoverSaved(f);
  await Promise.resolve();
  f.writer.owned = false;
  wait.resolve(loaded(f.head()));
  await assert.rejects(beginning, /read-only/);
  assert.equal(f.workspace.canRun, true);
  assert.deepEqual(f.events, ["pause", "resume"]);
});

test("saved-disk recovery cannot replace an active or uncertain publication session", async () => {
  const f = fixture();
  const token = await enter(f);
  await assert.rejects(recoverSaved(f), /already active/);
  f.workspace.stage(token, disk(2));
  f.runtime.activate = () => {
    throw new Error("activation failed");
  };
  await assert.rejects(f.workspace.commit(token), /activation failed/);
  assert.equal(f.workspace.state, "recovery");
  await assert.rejects(recoverSaved(f), /already active/);
  assert.equal(f.workspace.state, "recovery");
  assert.throws(() => f.workspace.cancel(token), /Stale/);
});

test("missing, rejected or unavailable exclusive locks yield read-only leases", async () => {
  const missing = await acquireDiskWriter({ locks: null });
  assert.equal(missing.owned, false);
  assert.match(missing.error.message, /unavailable/);
  await missing.release();
  const denied = await acquireDiskWriter({
    locks: {
      request: async () => {
        throw new Error("denied");
      },
    },
  });
  assert.equal(denied.owned, false);
  assert.match(denied.error.message, /denied/);
  const busy = await acquireDiskWriter({
    locks: {
      request: async (_, options, callback) => {
        assert.deepEqual(options, { mode: "exclusive", ifAvailable: true });
        return callback(null);
      },
    },
  });
  assert.equal(busy.owned, false);
});

test("exclusive lease stays held until release waits for lock callback completion", async () => {
  let finished = false;
  const lease = await acquireDiskWriter({
    name: "test",
    locks: {
      request: async (name, _, callback) => {
        assert.equal(name, "test");
        await callback({ name });
        finished = true;
      },
    },
  });
  assert.equal(lease.owned, true);
  assert.equal(finished, false);
  await lease.release();
  assert.equal(lease.owned, false);
  assert.equal(finished, true);
  await lease.release();
});

test("no lease permits execution but never storage mutations or management", async () => {
  const f = fixture();
  f.writer.owned = false;
  assert.equal(f.workspace.canRun, true);
  await assert.rejects(f.workspace.saveCheckpoint(disk(2)), /read-only/);
  await assert.rejects(enter(f), /read-only/);
  assert.deepEqual(f.events, []);
});

test("save-and-exit acknowledgment and readiness are required; rejection resumes intact", async () => {
  const f = fixture();
  await assert.rejects(f.workspace.beginManagement(), /Save and exit/);
  f.runtime.ready = () => false;
  await assert.rejects(enter(f), /not idle/);
  assert.equal(f.workspace.canRun, true);
  assert.deepEqual(f.events, ["pause", "resume"]);
  assert.equal(f.head().revision, 1);
});

test("autosaves copy bytes, serialize and precede the acknowledged management checkpoint", async () => {
  const f = fixture();
  const wait = deferred();
  const save = f.store.saveCheckpoint;
  let first = true;
  f.store.saveCheckpoint = async (...args) => {
    if (first) {
      first = false;
      await wait.promise;
    }
    return save(...args);
  };
  const value = disk(2);
  const one = f.workspace.saveCheckpoint(value);
  value.drives.A.bytes.fill(99);
  const two = f.workspace.saveCheckpoint(disk(3));
  const beginning = enter(f);
  assert.equal(f.workspace.canRun, false);
  await assert.rejects(f.workspace.saveCheckpoint(disk(4)), /gates autosaves/);
  wait.resolve();
  await Promise.all([one, two]);
  const token = await beginning;
  assert.deepEqual(f.events, ["pause", "save:2", "save:3", "save:1"]);
  assert.equal(f.workspace.inspect(token).token.revision, 4);
  assert.equal(f.head().drives.A.bytes[0], 1);
});

test("a failed checkpoint rejects and retries without another flush", async () => {
  const f = fixture();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async () => {
    throw new Error("quota");
  };
  await assert.rejects(f.workspace.saveCheckpoint(disk(2)), /quota/);
  assert.equal(f.workspace.token.revision, 1);
  f.store.saveCheckpoint = save;
  await f.workspace.retryCheckpoint();
  assert.equal(f.head().drives.A.bytes[0], 2);
  assert.equal(f.workspace.token.revision, 2);
});

test("a failed management barrier resumes and retains its exact checkpoint for retry", async () => {
  const f = fixture();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async () => {
    throw new Error("abort");
  };
  await assert.rejects(enter(f), /abort/);
  assert.equal(f.workspace.canRun, true);
  f.store.saveCheckpoint = save;
  await f.workspace.retryCheckpoint();
  assert.equal(f.head().drives.A.bytes[0], 1);
});

test("private baseline/candidate copies publish with backup before CPU adoption", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.inspect(token).snapshot.drives.A.bytes.fill(9);
  assert.equal(f.workspace.inspect(token).snapshot.drives.A.bytes[0], 1);
  const candidate = disk(2);
  f.workspace.stage(token, candidate);
  candidate.drives.A.bytes.fill(9);
  const receipt = await f.workspace.commit(token);
  assert.deepEqual(Object.keys(receipt).sort(), [
    "digest",
    "operationId",
    "revision",
  ]);
  assert.equal(receipt.digest, digest(disk(2)));
  assert.deepEqual(f.events, [
    "pause",
    "save:1",
    "prepare:2",
    "commit:2",
    "activate:2",
    "resume",
  ]);
  assert.equal(f.changes.get("change-1").before.drives.A.bytes[0], 1);
  assert.equal(f.workspace.canRun, true);
  assert.throws(() => f.workspace.stage(token, disk(3)), /Stale/);
});

test("cancel invalidates delayed file reads, including when a new session exists", async () => {
  const f = fixture();
  const old = await enter(f);
  const read = deferred();
  const stage = read.promise.then((bytes) => f.workspace.stage(old, bytes));
  f.workspace.cancel(old);
  const current = await enter(f);
  read.resolve(disk(9));
  await assert.rejects(stage, /Stale/);
  f.workspace.stage(current, disk(2));
  await f.workspace.commit(current);
  assert.equal(f.head().drives.A.bytes[0], 2);
});

test("cancel during async preparation resumes original and discards late candidate", async () => {
  const f = fixture();
  const token = await enter(f);
  const wait = deferred();
  f.runtime.prepare = () => wait.promise;
  f.workspace.stage(token, disk(2));
  const committing = f.workspace.commit(token);
  f.workspace.cancel(token);
  wait.resolve({ disk: disk(2) });
  await assert.rejects(committing, /Stale/);
  assert.equal(f.workspace.canRun, true);
  assert.equal(f.head().drives.A.bytes[0], 1);
  assert.deepEqual(f.events.slice(-2), ["resume", "discard:2"]);
});

test("preparation failure has no publication and permits cancellation", async () => {
  const f = fixture();
  const token = await enter(f);
  f.runtime.prepare = async () => {
    throw new Error("bad CPU image");
  };
  f.workspace.stage(token, disk(2));
  await assert.rejects(f.workspace.commit(token), /bad CPU image/);
  assert.equal(f.workspace.state, "managing");
  f.workspace.cancel(token);
  assert.equal(f.workspace.canRun, true);
  assert.equal(f.head().drives.A.bytes[0], 1);
});

test("aborted publication leaves baseline and permits same-operation retry", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  const commit = f.store.commitChange;
  f.store.commitChange = async () => {
    throw new Error("quota");
  };
  await assert.rejects(f.workspace.commit(token), /quota/);
  assert.equal(f.workspace.state, "managing");
  assert.equal(f.head().drives.A.bytes[0], 1);
  assert.throws(() => f.workspace.stage(token, disk(3)), /bound/);
  f.store.commitChange = commit;
  await f.workspace.commit(token);
  assert.equal(f.head().drives.A.bytes[0], 2);
  assert.equal(f.changes.size, 1);
});

test("lost commit response stays stopped; same identity retry converges without another backup", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  const commit = f.store.commitChange;
  f.store.commitChange = async (...args) => {
    await commit(...args);
    throw new Error("lost response");
  };
  await assert.rejects(f.workspace.commit(token), /lost response/);
  assert.equal(f.workspace.state, "recovery");
  assert.equal(f.workspace.canRun, false);
  assert.equal(f.workspace.recovery.operationId, "change-1");
  assert.throws(() => f.workspace.cancel(token), /Stale/);
  f.store.commitChange = commit;
  await f.workspace.commit(token);
  assert.equal(f.workspace.canRun, true);
  assert.equal(f.changes.size, 1);
  assert.equal(f.head().revision, 3);
});

test("recovery retry cannot cancel during preparation and resume the old CPU", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  f.runtime.activate = () => {
    throw new Error("activation failed");
  };
  await assert.rejects(f.workspace.commit(token), /activation failed/);
  const wait = deferred();
  f.runtime.prepare = () => wait.promise;
  const retry = f.workspace.commit(token);
  assert.throws(() => f.workspace.cancel(token), /requires recovery/);
  wait.reject(new Error("prepare failed"));
  await assert.rejects(retry, /prepare failed/);
  assert.equal(f.workspace.state, "recovery");
  assert.equal(f.events.includes("resume"), false);
});

test("an old idempotent receipt cannot activate over a newer committed head", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  const commit = f.store.commitChange;
  f.store.commitChange = async (...args) => {
    const receipt = await commit(...args);
    f.setHead({
      ...disk(9),
      revision: receipt.revision + 1,
      operationId: "other-writer",
    });
    return receipt;
  };
  await assert.rejects(f.workspace.commit(token), /Committed disk changed/);
  assert.equal(f.workspace.state, "recovery");
  f.store.commitChange = commit;
  await assert.rejects(f.workspace.commit(token), /Committed disk changed/);
  await assert.rejects(f.workspace.saveCheckpoint(disk(1)), /gates autosaves/);
  assert.equal(
    f.events.some((event) => event.startsWith("activate")),
    false,
  );
  assert.equal(f.head().drives.A.bytes[0], 9);
});

test("activation failure retains committed recovery and never frees or resumes an uncertain CPU", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  f.runtime.activate = () => {
    throw new Error("activation failed");
  };
  await assert.rejects(f.workspace.commit(token), /activation failed/);
  assert.equal(f.workspace.state, "recovery");
  assert.equal(f.workspace.recovery.operationId, "change-1");
  assert.equal(f.workspace.recovery.receipt.digest, digest(disk(2)));
  assert.equal(f.head().drives.A.bytes[0], 2);
  assert.equal(f.events.includes("resume"), false);
  assert.equal(f.events.includes("discard:2"), false);
});

test("ownership loss during preparation prevents the publication", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  f.runtime.prepare = async (value) => {
    f.writer.owned = false;
    return { disk: value };
  };
  await assert.rejects(f.workspace.commit(token), /read-only/);
  assert.equal(f.head().drives.A.bytes[0], 1);
  assert.equal(f.events.includes("commit:2"), false);
});

test("close waits for in-flight publication and prevents activation or reopening state", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  const started = deferred();
  const wait = deferred();
  const commit = f.store.commitChange;
  f.store.commitChange = async (...args) => {
    started.resolve();
    await wait.promise;
    return commit(...args);
  };
  const committing = f.workspace.commit(token);
  await started.promise;
  let closed = false;
  const closing = f.workspace.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  wait.resolve();
  await assert.rejects(committing, /closed after publication/);
  await closing;
  assert.equal(f.workspace.state, "closed");
  assert.equal(f.workspace.canRun, false);
  assert.equal(
    f.events.some((event) => event.startsWith("activate")),
    false,
  );
});

test("autosave bounds work to one flight and one newest pending snapshot; superseded is not saved", async () => {
  const f = fixture(),
    started = deferred(),
    wait = deferred();
  const save = f.store.saveCheckpoint;
  let calls = 0;
  f.store.saveCheckpoint = async (...args) => {
    if (++calls === 1) {
      started.resolve();
      await wait.promise;
    }
    return save(...args);
  };
  const first = f.workspace.saveCheckpoint(disk(2));
  await started.promise;
  const waiting = [];
  for (let byte = 3; byte < 203; byte++) {
    const source = disk(byte);
    waiting.push(f.workspace.saveCheckpoint(source));
    source.drives.A.bytes.fill(255);
  }
  assert.equal(calls, 1);
  assert.deepEqual(
    await Promise.all(waiting.slice(0, -1)),
    Array.from({ length: 199 }, () => ({ kind: "superseded" })),
  );
  wait.resolve();
  const [one, last] = await Promise.all([first, waiting.at(-1)]);
  assert.equal(one.kind, "saved");
  assert.equal(one.receipt.digest, digest(disk(2)));
  assert.equal(last.kind, "saved");
  assert.equal(last.receipt.digest, digest(disk(202)));
  assert.equal(calls, 2);
  assert.deepEqual(f.events, ["save:2", "save:202"]);
  assert.equal(f.workspace.retryCheckpoint(), undefined);
});

test("a failed in-flight save rejects waiting acknowledgments and retains only the newest snapshot for retry", async () => {
  const f = fixture(),
    started = deferred(),
    wait = deferred();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async () => {
    started.resolve();
    await wait.promise;
    throw new Error("quota");
  };
  const first = f.workspace.saveCheckpoint(disk(2));
  await started.promise;
  const replaced = f.workspace.saveCheckpoint(disk(3));
  const latest = f.workspace.saveCheckpoint(disk(4));
  assert.deepEqual(await replaced, { kind: "superseded" });
  const rejected = Promise.allSettled([first, latest]);
  wait.resolve();
  assert(
    (await rejected).every(
      (value) =>
        value.status === "rejected" && /quota/.test(value.reason.message),
    ),
  );
  f.store.saveCheckpoint = save;
  const retry = await f.workspace.retryCheckpoint();
  assert.equal(retry.kind, "saved");
  assert.equal(f.head().drives.A.bytes[0], 4);
  assert.deepEqual(f.events, ["save:4"]);
});

test("whole-set autosave copies both checkpoint vectors without requiring all-drive readiness", async () => {
  const f = fixture();
  f.runtime.ready = () =>
    assert.fail("Autosave must not use the manual readiness gate");
  // These are last-successful checkpoints, not live backing images. The host
  // boundary's guest flush/eviction proof is separate from this coordinator test.
  for (const [a, b] of [
    [7, 2],
    [7, 8],
  ]) {
    const vector = driveSet(a, b);
    const saving = f.workspace.saveCheckpoint(vector);
    vector.drives.A.bytes.fill(99);
    vector.drives.B.bytes.fill(99);
    vector.bootstrap.bytes.fill(99);
    const result = await saving;
    assert.equal(result.kind, "saved");
    assert(f.head().drives.A.bytes.every((byte) => byte === a));
    assert(f.head().drives.B.bytes.every((byte) => byte === b));
    assert(f.head().bootstrap.bytes.every((byte) => byte === 42));
  }
});

test("manual staging and activation preserve independent A/B and bootstrap copies", async () => {
  const f = fixture();
  const baseline = driveSet(1, 2);
  f.runtime.checkpoint = () => baseline;
  const session = await enter(f);
  const view = f.workspace.inspect(session);
  view.snapshot.drives.A.bytes.fill(90);
  view.snapshot.drives.B.bytes.fill(90);
  view.snapshot.bootstrap.bytes.fill(90);
  view.token.revision = 90;
  const candidate = driveSet(3, 4);
  f.workspace.stage(session, candidate);
  candidate.drives.A.bytes.fill(90);
  candidate.drives.B.bytes.fill(90);
  candidate.bootstrap.bytes.fill(90);
  const receipt = await f.workspace.commit(session);
  assert.equal(receipt.digest, digest(driveSet(3, 4)));
  const before = f.changes.get("change-1").before;
  assert(before.drives.A.bytes.every((byte) => byte === 1));
  assert(before.drives.B.bytes.every((byte) => byte === 2));
  assert(f.head().drives.A.bytes.every((byte) => byte === 3));
  assert(f.head().drives.B.bytes.every((byte) => byte === 4));
  const token = f.workspace.token;
  token.revision = 100;
  assert.equal(f.workspace.token.revision, receipt.revision);
});

test("same-revision loaded head with changed B, bootstrap or receipt cannot activate", async () => {
  for (const mutate of [
    (head) => {
      head.snapshot.drives.B.bytes[511] = 99;
    },
    (head) => {
      head.snapshot.bootstrap.bytes[255] = 99;
    },
    (head) => {
      head.receipt.digest = "f".repeat(64);
    },
    (head) => {
      head.receipt.revision += 1;
    },
  ]) {
    const f = fixture();
    const session = await enter(f);
    f.workspace.stage(session, driveSet(1, 2));
    const load = f.store.load;
    f.store.load = async () => {
      const head = await load();
      mutate(head);
      return head;
    };
    await assert.rejects(f.workspace.commit(session), /Committed disk changed/);
    assert.equal(f.workspace.state, "recovery");
    assert(!f.events.some((event) => event.startsWith("activate")));
  }
});

test("legacy recovery retains its opaque expected token without inventing a numeric revision", async () => {
  const f = fixture(),
    expected = { kind: "legacy", identity: "a".repeat(64) };
  f.store.load = async () => ({
    kind: "ready",
    token: expected,
    snapshot: disk(7),
  });
  const session = await recoverSaved(f);
  assert.deepEqual(f.workspace.token, expected);
  assert.deepEqual(f.workspace.inspect(session).token, expected);
  f.workspace.stage(session, disk(8));
  f.store.commitChange = async (token, operationId, value) => {
    assert.deepEqual(token, expected);
    const head = { ...clone(value), revision: 10, operationId };
    f.setHead(head);
    f.store.load = async () => loaded(head);
    return receipt(head);
  };
  assert.equal((await f.workspace.commit(session)).revision, 10);
  assert.deepEqual(f.workspace.token, { kind: "v3", revision: 10 });
});

test("empty, recovery and inconsistent v3 receipt shapes cannot become a management baseline", async () => {
  for (const value of [
    { kind: "empty", token: { kind: "empty" } },
    { kind: "recovery", error: "bad blob" },
    { kind: "ready", token: { kind: "v3", revision: 1 }, snapshot: disk(0) },
    {
      kind: "ready",
      token: { kind: "v3", revision: 1 },
      snapshot: disk(0),
      receipt: { ...receipt({ ...disk(0), revision: 2, operationId: "bad" }) },
    },
  ]) {
    const f = fixture();
    f.store.load = async () => value;
    await assert.rejects(recoverSaved(f), /saved drive.set/i);
    assert.equal(f.workspace.canRun, true);
    assert.deepEqual(f.events, ["pause", "resume"]);
  }
});

test("close rejects the waiting snapshot, drains only the active save and prevents a later retry", async () => {
  const f = fixture(),
    started = deferred(),
    wait = deferred();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async (...args) => {
    started.resolve();
    await wait.promise;
    return save(...args);
  };
  const first = f.workspace.saveCheckpoint(disk(2));
  await started.promise;
  const pending = f.workspace.saveCheckpoint(disk(3));
  const failed = assert.rejects(pending, /closed/);
  let complete = false;
  const closing = f.workspace.close().then(() => {
    complete = true;
  });
  await failed;
  assert.equal(complete, false);
  wait.resolve();
  assert.equal((await first).kind, "saved");
  await closing;
  assert.equal(f.workspace.state, "closed");
  assert.deepEqual(f.events, ["pause", "save:2"]);
  assert.equal(f.workspace.retryCheckpoint(), undefined);
});

test("close drains active publication before reporting a pause failure", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.stage(token, disk(2));
  const started = deferred();
  const wait = deferred();
  const commit = f.store.commitChange;
  f.store.commitChange = async (...args) => {
    started.resolve();
    await wait.promise;
    return commit(...args);
  };
  const committing = f.workspace.commit(token);
  const rejectedCommit = assert.rejects(committing, /closed after publication/);
  await started.promise;
  const pauseError = new Error("pause failed");
  f.runtime.pause = () => {
    throw pauseError;
  };
  let settled = false;
  const closing = f.workspace.close().then(
    () => {
      settled = true;
      assert.fail("close must preserve the pause failure");
    },
    (error) => {
      settled = true;
      assert.equal(error, pauseError);
    },
  );
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(f.workspace.state, "closed");
  assert.equal(f.workspace.canRun, false);
  wait.resolve();
  await rejectedCommit;
  await closing;
  assert.equal(settled, true);
  assert.equal(f.head().drives.A.bytes[0], 2);
  assert.equal(f.workspace.state, "closed");
  assert.equal(
    f.events.some((event) => event.startsWith("activate")),
    false,
  );
});

test("close before the autosave starts prevents any storage publication", async () => {
  const f = fixture();
  const saving = f.workspace.saveCheckpoint(disk(2));
  const rejected = assert.rejects(saving, /Superseded/);
  await f.workspace.close();
  await rejected;
  assert.deepEqual(f.events, ["pause"]);
  assert.equal(f.workspace.retryCheckpoint(), undefined);
});

test("ownership loss during the management barrier cannot produce a live management session", async () => {
  const f = fixture();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async (...args) => {
    const receipt = await save(...args);
    f.writer.owned = false;
    return receipt;
  };
  await assert.rejects(enter(f), /read-only/);
  assert.equal(f.workspace.canRun, true);
  assert.deepEqual(f.events, ["pause", "save:1", "resume"]);
});

test("ownership is rechecked before the pending autosave starts", async () => {
  const f = fixture(),
    started = deferred(),
    wait = deferred();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async (...args) => {
    started.resolve();
    await wait.promise;
    const receipt = await save(...args);
    f.writer.owned = false;
    return receipt;
  };
  const first = f.workspace.saveCheckpoint(disk(2));
  await started.promise;
  const second = f.workspace.saveCheckpoint(disk(3));
  const rejected = assert.rejects(second, /read-only/);
  wait.resolve();
  assert.equal((await first).kind, "saved");
  await rejected;
  assert.deepEqual(f.events, ["save:2"]);
  f.writer.owned = true;
  f.store.saveCheckpoint = save;
  assert.equal((await f.workspace.retryCheckpoint()).kind, "saved");
  assert.deepEqual(f.events, ["save:2", "save:3"]);
});
