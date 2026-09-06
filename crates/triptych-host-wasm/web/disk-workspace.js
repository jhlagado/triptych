import { copyDriveSet } from "./drive-set.js";

function sameBytes(a, b) {
  return a?.length === b?.length && a.every((byte, index) => byte === b[index]);
}

function sameDisk(a, b) {
  if (a === null || b === null) return a === b;
  return a?.name === b?.name && sameBytes(a.bytes, b.bytes);
}

function sameSet(a, b) {
  return (
    a?.bootstrap?.profile === b?.bootstrap?.profile &&
    sameBytes(a.bootstrap.bytes, b.bootstrap.bytes) &&
    sameDisk(a.drives.A, b.drives.A) &&
    sameDisk(a.drives.B, b.drives.B)
  );
}

function copyToken(value) {
  if (value?.kind === "empty") return { kind: "empty" };
  if (
    value?.kind === "legacy" &&
    typeof value.identity === "string" &&
    /^[a-f0-9]{64}$/.test(value.identity)
  )
    return { kind: "legacy", identity: value.identity };
  if (
    value?.kind === "v3" &&
    Number.isSafeInteger(value.revision) &&
    value.revision > 0
  )
    return { kind: "v3", revision: value.revision };
  throw new Error("Invalid saved drive-set token.");
}

const sameToken = (a, b) =>
  JSON.stringify(copyToken(a)) === JSON.stringify(copyToken(b));

function copyReceipt(value) {
  copyToken({ kind: "v3", revision: value?.revision });
  if (
    typeof value.operationId !== "string" ||
    !value.operationId ||
    value.operationId.length > 256 ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    throw new Error("Invalid drive-set receipt.");
  return {
    revision: value.revision,
    operationId: value.operationId,
    digest: value.digest,
  };
}

function savedHead(value) {
  if (value?.kind !== "ready")
    throw new Error("A valid saved drive set is required for recovery.");
  const token = copyToken(value.token);
  if (token.kind === "empty")
    throw new Error("A valid saved drive set is required for recovery.");
  const receipt =
    value.receipt === undefined ? undefined : copyReceipt(value.receipt);
  if (token.kind === "v3" && receipt?.revision !== token.revision)
    throw new Error("Invalid saved drive-set receipt.");
  return { token, snapshot: copyDriveSet(value.snapshot), receipt };
}

/** Hold this lease for the writable workspace's entire lifetime. Acquisition
 * never waits for another tab: missing/denied/unavailable locks mean read-only.
 * Close/drain the workspace before release; never release during a transaction.
 */
export async function acquireDiskWriter({
  locks = globalThis.navigator?.locks,
  name = "triptych-cpu:disk-writer",
} = {}) {
  let owned = false;
  let error;
  let release;
  let settle;
  const acquired = new Promise((resolve) => (settle = resolve));
  const held = new Promise((resolve) => (release = resolve));
  let request;
  try {
    if (!locks?.request)
      throw new Error("Exclusive browser locks unavailable.");
    request = Promise.resolve(
      locks.request(
        name,
        { mode: "exclusive", ifAvailable: true },
        async (lock) => {
          owned = lock !== null;
          settle();
          if (owned) await held;
          owned = false;
        },
      ),
    ).catch((cause) => {
      error = cause;
      owned = false;
      settle();
    });
  } catch (cause) {
    error = cause;
    settle();
  }
  await acquired;
  return {
    get owned() {
      return owned;
    },
    get error() {
      return error;
    },
    async release() {
      owned = false;
      release();
      await request;
    },
  };
}

/** Coordinates one already-installed machine and its matching stored head token.
 * pause/resume/ready/checkpoint/activate are synchronous host hooks. pause must
 * stop scheduling AND gate all input/reset/open paths. prepare may be async; it
 * creates an unexecuted CPU from the EXACT complete drive set and bootstrap,
 * without resident-system overlays. Autosaves retain at most two snapshots;
 * management additionally owns its private baseline/candidate while paused.
 * activate transfers ownership of that CPU; discard frees unadopted candidates.
 * The caller must route ALL disk writes through this object, and use canRun for
 * every scheduled slice and guest-input path. Recovery uses only the durable
 * head and requires explicit consent to discard volatile state on replacement.
 */
export function createDiskWorkspace({
  store,
  writer,
  runtime,
  token = { kind: "empty" },
  operationId = () => globalThis.crypto.randomUUID(),
}) {
  let headToken = copyToken(token);
  let state = "running";
  let epoch = 0;
  let active;
  let pending;
  let inFlight;
  let queue = Promise.resolve();
  let recovery;

  const owned = () => {
    if (!writer?.owned)
      throw new Error(
        "This workspace is read-only: no exclusive disk ownership.",
      );
  };
  const enqueue = (action) => {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  };
  const session = (token, allowed = ["managing"]) => {
    if (active?.token !== token || !allowed.includes(state))
      throw new Error("Stale or unavailable disk-management session.");
    return active;
  };
  const recover = (error, receipt) => {
    state = "recovery";
    recovery = { error, operationId: active?.operationId, receipt };
  };
  const resume = () => {
    try {
      runtime.resume();
      state = "running";
    } catch (error) {
      recover(error);
      throw error;
    }
  };
  const save = async (value) => {
    owned();
    const receipt = copyReceipt(
      await store.saveCheckpoint(copyToken(headToken), value),
    );
    headToken = { kind: "v3", revision: receipt.revision };
    return receipt;
  };

  const settle = (job, result, error) => {
    if (job?.settled) return;
    job.settled = true;
    if (error) job.reject(error);
    else job.resolve(result);
  };
  const forgetPending = (error) => {
    if (pending) settle(pending, { kind: "superseded" }, error);
    pending = undefined;
  };
  const retainRetry = (snapshot) => {
    forgetPending();
    pending = { snapshot, generation: epoch, settled: true };
  };
  const pump = async () => {
    while (inFlight) {
      const job = inFlight;
      try {
        if (job.generation !== epoch)
          throw new Error("Superseded machine checkpoint.");
        const receipt = await save(job.snapshot);
        settle(job, { kind: "saved", receipt });
      } catch (error) {
        settle(job, undefined, error);
        if (state !== "closed" && job.generation === epoch) {
          if (pending) settle(pending, undefined, error);
          else pending = job;
        } else forgetPending(error);
        inFlight = undefined;
        return;
      }
      inFlight = pending;
      pending = undefined;
    }
  };

  // Each actual save resolves {kind:'saved',receipt}. Replacing a waiting job
  // resolves it immediately as {kind:'superseded'}, NOT as a persistence receipt.
  // Keep no waiter list or snapshot closure for those superseded submissions.
  // On failure both live waiters reject; only the newest snapshot stays retryable.
  const submit = (value) => {
    try {
      if (state !== "running")
        throw new Error("Disk management gates autosaves.");
      owned();
      const snapshot = copyDriveSet(value);
      let resolve, reject;
      const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const job = {
        snapshot,
        generation: epoch,
        resolve,
        reject,
        settled: false,
      };
      forgetPending();
      if (inFlight) pending = job;
      else {
        inFlight = job;
        void enqueue(pump);
      }
      return promise;
    } catch (error) {
      return Promise.reject(error);
    }
  };

  return {
    get state() {
      return state;
    },
    get token() {
      return copyToken(headToken);
    },
    get canRun() {
      return state === "running";
    },
    get recovery() {
      return (
        recovery && {
          ...recovery,
          receipt: recovery.receipt && copyReceipt(recovery.receipt),
        }
      );
    },
    saveCheckpoint: submit,
    retryCheckpoint() {
      if (pending) return submit(pending.snapshot);
    },
    async beginManagement({ savedAndExited = false } = {}) {
      owned();
      if (state !== "running")
        throw new Error("Disk management is already active.");
      if (!savedAndExited)
        throw new Error("Save and exit the guest program first.");
      state = "entering";
      const generation = epoch;
      try {
        runtime.pause();
        if (!runtime.ready())
          throw new Error("Guest storage or input is not idle.");
        const baseline = copyDriveSet(runtime.checkpoint());
        const identity = operationId();
        if (typeof identity !== "string" || !identity || identity.length > 256)
          throw new Error("Invalid disk operation identity.");
        const receipt = await enqueue(async () => {
          if (generation !== epoch)
            throw new Error("Superseded management request.");
          forgetPending();
          try {
            return await save(baseline);
          } catch (error) {
            if (state !== "closed" && generation === epoch)
              retainRetry(baseline);
            throw error;
          }
        });
        if (generation !== epoch)
          throw new Error("Superseded management request.");
        owned();
        forgetPending();
        const token = Object.freeze({});
        active = {
          token,
          operationId: identity,
          baseline,
          expected: { kind: "v3", revision: receipt.revision },
        };
        state = "managing";
        return token;
      } catch (error) {
        if (state !== "closed") resume();
        throw error;
      }
    },
    async beginRecovery({ discardVolatile = false } = {}) {
      owned();
      if (state !== "running")
        throw new Error("Disk management is already active.");
      if (discardVolatile !== true)
        throw new Error("Acknowledge discarding volatile guest state first.");
      state = "entering";
      const generation = epoch;
      try {
        runtime.pause();
        const identity = operationId();
        if (typeof identity !== "string" || !identity || identity.length > 256)
          throw new Error("Invalid disk operation identity.");
        // Accepted checkpoints finish first. Never export or save live state
        // here: a faulted or nonbooting guest need not have an idle disk cache.
        const head = await enqueue(async () => {
          if (generation !== epoch)
            throw new Error("Superseded recovery request.");
          owned();
          return store.load();
        });
        if (generation !== epoch)
          throw new Error("Superseded recovery request.");
        owned();
        const loaded = savedHead(head);
        const baseline = loaded.snapshot;
        // An unacknowledged autosave may already have advanced the durable
        // head. Its loaded revision, not the old CPU's revision, is authoritative.
        headToken = loaded.token;
        epoch += 1;
        forgetPending();
        const token = Object.freeze({});
        active = {
          token,
          operationId: identity,
          baseline,
          expected: copyToken(headToken),
        };
        state = "managing";
        return token;
      } catch (error) {
        if (state !== "closed") resume();
        throw error;
      }
    },
    inspect(token) {
      const current = session(token, [
        "managing",
        "preparing",
        "publishing",
        "recovery",
      ]);
      return {
        snapshot: copyDriveSet(current.baseline),
        token: copyToken(current.expected),
        operationId: current.operationId,
      };
    },
    stage(token, value) {
      const current = session(token);
      if (current.attempted)
        throw new Error(
          "This operation is already bound to its candidate; retry or cancel.",
        );
      current.candidate = copyDriveSet(value);
    },
    cancel(token) {
      const current = session(token, ["managing", "preparing"]);
      if (current.recovering)
        throw new Error(
          "Publication requires recovery; the old CPU cannot resume.",
        );
      active = undefined;
      epoch += 1;
      resume();
    },
    async commit(token) {
      const current = session(token, ["managing", "recovery"]);
      owned();
      if (!current.candidate)
        throw new Error("No candidate disk has been staged.");
      const wasRecovery = state === "recovery";
      current.recovering = wasRecovery;
      state = "preparing";
      let prepared;
      try {
        prepared = await runtime.prepare(copyDriveSet(current.candidate));
        session(token, ["preparing"]);
        owned();
      } catch (error) {
        if (prepared !== undefined) runtime.discard(prepared);
        if (active === current && state !== "closed") {
          if (wasRecovery) recover(error);
          else state = "managing";
        }
        throw error;
      }
      state = "publishing";
      current.attempted = true;
      return enqueue(async () => {
        let receipt;
        try {
          if (state === "closed")
            throw new Error("Workspace closed before publication.");
          owned();
          receipt = copyReceipt(
            await store.commitChange(
              copyToken(current.expected),
              current.operationId,
              copyDriveSet(current.candidate),
            ),
          );
        } catch (error) {
          try {
            const head = await store.load();
            if (state === "closed") {
              // Closing is terminal even when an in-flight transaction fails.
            } else if (
              !wasRecovery &&
              head?.kind === "ready" &&
              sameToken(head.token, current.expected) &&
              sameSet(head.snapshot, current.baseline)
            ) {
              state = "managing";
            } else {
              recover(error, head?.receipt);
            }
          } catch {
            if (state !== "closed") recover(error);
          }
          runtime.discard(prepared);
          throw error;
        }
        try {
          // Idempotent retries can return an OLD receipt. Never boot it over a
          // newer head, even though the original publication succeeded.
          const head = await store.load();
          if (
            head?.kind !== "ready" ||
            !sameToken(head.token, {
              kind: "v3",
              revision: receipt.revision,
            }) ||
            head.receipt?.operationId !== current.operationId ||
            !sameToken(
              { kind: "v3", revision: head.receipt?.revision },
              head.token,
            ) ||
            head.receipt?.digest !== receipt.digest ||
            receipt.operationId !== current.operationId ||
            !sameSet(head.snapshot, current.candidate)
          )
            throw new Error(
              "Committed disk changed; reload or recover before continuing.",
            );
          owned();
          if (state === "closed")
            throw new Error("Workspace closed after publication.");
          headToken = copyToken(head.token);
        } catch (error) {
          runtime.discard(prepared);
          if (state !== "closed") recover(error, receipt);
          throw error;
        }
        try {
          runtime.activate(prepared);
          epoch += 1;
          forgetPending();
          recovery = undefined;
          resume();
          active = undefined;
          return copyReceipt(receipt);
        } catch (error) {
          // Ownership may already have transferred. Do not free either CPU or
          // resume the old one after activation starts; retain durable recovery.
          recover(error, receipt);
          throw error;
        }
      });
    },
    async close() {
      state = "closed";
      epoch += 1;
      forgetPending(
        new Error("Workspace closed before checkpoint publication."),
      );
      try {
        runtime.pause();
      } finally {
        // Drain publications before the caller can release its writer lease,
        // even when pausing fails. The settled queue preserves the pause error.
        await queue;
      }
    },
  };
}
