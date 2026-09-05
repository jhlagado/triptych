function copyDisk(value) {
  if (
    typeof value?.name !== "string" ||
    !value.name ||
    !(value.bytes instanceof Uint8Array) ||
    !value.bytes.length ||
    value.bytes.length % 512 !== 0
  )
    throw new Error("A named, sector-aligned disk snapshot is required.");
  return { name: value.name, bytes: value.bytes.slice() };
}

function sameDisk(a, b) {
  return (
    a?.name === b?.name &&
    a?.bytes.length === b?.bytes.length &&
    a.bytes.every((byte, index) => byte === b.bytes[index])
  );
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

/** Coordinates one already-installed machine and its matching stored revision.
 * pause/resume/ready/checkpoint/activate are synchronous host hooks. pause must
 * stop scheduling AND gate all input/reset/open paths. prepare may be async; it
 * creates an unexecuted CPU from EXACT bytes, without resident-system overlays.
 * activate transfers ownership of that CPU; discard frees unadopted candidates.
 * The caller must route ALL disk writes through this object, and use canRun for
 * every scheduled slice and guest-input path. Recovery uses only the durable
 * head and requires explicit consent to discard volatile state on replacement.
 */
export function createDiskWorkspace({
  store,
  writer,
  runtime,
  revision = 0,
  operationId = () => globalThis.crypto.randomUUID(),
}) {
  if (!Number.isSafeInteger(revision) || revision < 0)
    throw new Error("Invalid initial disk revision.");
  let state = "running";
  let epoch = 0;
  let active;
  let pending;
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
    const receipt = await store.saveCheckpoint(revision, value);
    revision = receipt.revision;
    return receipt;
  };

  return {
    get state() {
      return state;
    },
    get revision() {
      return revision;
    },
    get canRun() {
      return state === "running";
    },
    get recovery() {
      return (
        recovery && {
          ...recovery,
          receipt: recovery.receipt && {
            ...recovery.receipt,
            ...copyDisk(recovery.receipt),
          },
        }
      );
    },
    async saveCheckpoint(value) {
      if (state !== "running")
        throw new Error("Disk management gates autosaves.");
      owned();
      const captured = copyDisk(value);
      pending = captured;
      const generation = epoch;
      return enqueue(async () => {
        if (generation !== epoch)
          throw new Error("Superseded machine checkpoint.");
        const receipt = await save(captured);
        if (pending === captured) pending = undefined;
        return receipt;
      });
    },
    async retryCheckpoint() {
      if (pending) return this.saveCheckpoint(pending);
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
        const baseline = copyDisk(runtime.checkpoint());
        pending = baseline;
        const identity = operationId();
        if (typeof identity !== "string" || !identity || identity.length > 256)
          throw new Error("Invalid disk operation identity.");
        const receipt = await enqueue(async () => {
          if (generation !== epoch)
            throw new Error("Superseded management request.");
          return save(baseline);
        });
        if (generation !== epoch)
          throw new Error("Superseded management request.");
        pending = undefined;
        const token = Object.freeze({});
        active = {
          token,
          operationId: identity,
          baseline,
          revision: receipt.revision,
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
        if (!Number.isSafeInteger(head?.revision) || head.revision < 1)
          throw new Error(
            "A valid saved disk revision is required for recovery.",
          );
        const baseline = copyDisk(head);
        // An unacknowledged autosave may already have advanced the durable
        // head. Its loaded revision, not the old CPU's revision, is authoritative.
        revision = head.revision;
        epoch += 1;
        pending = undefined;
        const token = Object.freeze({});
        active = {
          token,
          operationId: identity,
          baseline,
          revision,
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
        ...copyDisk(current.baseline),
        revision: current.revision,
        operationId: current.operationId,
      };
    },
    stage(token, value) {
      const current = session(token);
      if (current.attempted)
        throw new Error(
          "This operation is already bound to its candidate; retry or cancel.",
        );
      current.candidate = copyDisk(value);
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
        prepared = await runtime.prepare(copyDisk(current.candidate));
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
          receipt = await store.commitChange(
            current.revision,
            current.operationId,
            copyDisk(current.candidate),
          );
        } catch (error) {
          try {
            const head = await store.load();
            if (state === "closed") {
              // Closing is terminal even when an in-flight transaction fails.
            } else if (
              !wasRecovery &&
              head?.revision === current.revision &&
              sameDisk(head, current.baseline)
            ) {
              state = "managing";
            } else {
              recover(error, head);
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
            !head ||
            head.revision !== receipt.revision ||
            head.operationId !== current.operationId ||
            !sameDisk(head, current.candidate)
          )
            throw new Error(
              "Committed disk changed; reload or recover before continuing.",
            );
          owned();
          if (state === "closed")
            throw new Error("Workspace closed after publication.");
          revision = head.revision;
        } catch (error) {
          runtime.discard(prepared);
          if (state !== "closed") recover(error, receipt);
          throw error;
        }
        try {
          runtime.activate(prepared);
          epoch += 1;
          pending = undefined;
          recovery = undefined;
          resume();
          active = undefined;
          return { ...receipt, ...copyDisk(receipt) };
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
      runtime.pause();
      await queue;
    },
  };
}
