import { test } from "node:test";
import assert from "node:assert/strict";
import {
  acquireDiskWriter,
  createDiskWorkspace,
} from "../../crates/triptych-host-wasm/web/disk-workspace.js";

const disk = (byte) => ({
  name: "work.img",
  bytes: new Uint8Array(512).fill(byte),
});
const clone = (value) => value && { ...value, bytes: value.bytes.slice() };
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
      return clone(head);
    },
    async saveCheckpoint(expected, value) {
      events.push(`save:${value.bytes[0]}`);
      assert.equal(expected, head.revision);
      head = {
        ...clone(value),
        revision: expected + 1,
        operationId: `checkpoint:${expected + 1}`,
      };
      return clone(head);
    },
    async commitChange(expected, operationId, value) {
      events.push(`commit:${value.bytes[0]}`);
      const previous = changes.get(operationId);
      if (previous) {
        assert.equal(expected, previous.before.revision);
        assert.deepEqual(value, {
          name: previous.after.name,
          bytes: previous.after.bytes,
        });
        return clone(previous.after);
      }
      assert.equal(expected, head.revision);
      const before = clone(head);
      head = { ...clone(value), revision: expected + 1, operationId };
      changes.set(operationId, { before, after: clone(head) });
      return clone(head);
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
      events.push(`prepare:${value.bytes[0]}`);
      return { disk: value };
    },
    activate(value) {
      events.push(`activate:${value.disk.bytes[0]}`);
      guest = clone(value.disk);
    },
    discard(value) {
      events.push(`discard:${value.disk.bytes[0]}`);
    },
  };
  const workspace = createDiskWorkspace({
    store,
    writer,
    runtime,
    revision: 1,
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
  value.bytes.fill(99);
  const two = f.workspace.saveCheckpoint(disk(3));
  const beginning = enter(f);
  assert.equal(f.workspace.canRun, false);
  await assert.rejects(f.workspace.saveCheckpoint(disk(4)), /gates autosaves/);
  wait.resolve();
  await Promise.all([one, two]);
  const token = await beginning;
  assert.deepEqual(f.events, ["pause", "save:2", "save:3", "save:1"]);
  assert.equal(f.workspace.inspect(token).revision, 4);
  assert.equal(f.head().bytes[0], 1);
});

test("a failed checkpoint rejects and retries without another flush", async () => {
  const f = fixture();
  const save = f.store.saveCheckpoint;
  f.store.saveCheckpoint = async () => {
    throw new Error("quota");
  };
  await assert.rejects(f.workspace.saveCheckpoint(disk(2)), /quota/);
  assert.equal(f.workspace.revision, 1);
  f.store.saveCheckpoint = save;
  await f.workspace.retryCheckpoint();
  assert.equal(f.head().bytes[0], 2);
  assert.equal(f.workspace.revision, 2);
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
  assert.equal(f.head().bytes[0], 1);
});

test("private baseline/candidate copies publish with backup before CPU adoption", async () => {
  const f = fixture();
  const token = await enter(f);
  f.workspace.inspect(token).bytes.fill(9);
  assert.equal(f.workspace.inspect(token).bytes[0], 1);
  const candidate = disk(2);
  f.workspace.stage(token, candidate);
  candidate.bytes.fill(9);
  const receipt = await f.workspace.commit(token);
  assert.equal(receipt.bytes[0], 2);
  assert.deepEqual(f.events, [
    "pause",
    "save:1",
    "prepare:2",
    "commit:2",
    "activate:2",
    "resume",
  ]);
  assert.equal(f.changes.get("change-1").before.bytes[0], 1);
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
  assert.equal(f.head().bytes[0], 2);
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
  assert.equal(f.head().bytes[0], 1);
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
  assert.equal(f.head().bytes[0], 1);
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
  assert.equal(f.head().bytes[0], 1);
  assert.throws(() => f.workspace.stage(token, disk(3)), /bound/);
  f.store.commitChange = commit;
  await f.workspace.commit(token);
  assert.equal(f.head().bytes[0], 2);
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
  assert.equal(f.head().bytes[0], 9);
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
  assert.equal(f.workspace.recovery.receipt.bytes[0], 2);
  assert.equal(f.head().bytes[0], 2);
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
  assert.equal(f.head().bytes[0], 1);
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
