import { acquireDiskWriter } from "./disk-workspace.js";

export const DIRECT_B_DATABASE = "triptych-direct-b-v1";
export const DIRECT_B_SLOT_COUNT = 8;
export const DIRECT_B_BYTES = 2_097_152;

const STORE = "slots";
const SLOT = /^B([1-8])$/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Direct B storage: ${message}.`);
}

function copyBytes(value) {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new Error("Direct B storage: invalid disk bytes.");
}

function slotNumber(value) {
  const match = SLOT.exec(value);
  requireValue(match, "invalid B slot");
  return Number(match[1]);
}

/** Parse the deliberately small URL vocabulary used by direct launches. */
export function parseDirectBSelection(value) {
  if (value === undefined || value === null || value === "") return "B1";
  requireValue(typeof value === "string", "invalid B selection");
  if (value.toLowerCase() === "auto") return "auto";
  const match = SLOT.exec(value);
  requireValue(match, "use auto or a slot from B1 to B8");
  return `B${match[1]}`;
}

function validateRecord(value, expectedSlot) {
  if (value === undefined) return undefined;
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid slot record",
  );
  const fields = ["slot", "name", "instanceId", "generation", "bytes"];
  requireValue(
    Reflect.ownKeys(value).length === fields.length &&
      fields.every((field) => Object.hasOwn(value, field)),
    "invalid slot record fields",
  );
  requireValue(value.slot === expectedSlot, "slot record key differs");
  requireValue(
    typeof value.name === "string" &&
      value.name.length > 0 &&
      value.name.length <= 64,
    "invalid slot name",
  );
  requireValue(
    typeof value.instanceId === "string" && UUID.test(value.instanceId),
    "invalid slot identity",
  );
  requireValue(
    Number.isSafeInteger(value.generation) && value.generation >= 1,
    "invalid slot generation",
  );
  const bytes = copyBytes(value.bytes);
  requireValue(bytes.length === DIRECT_B_BYTES, "invalid slot size");
  return {
    slot: value.slot,
    name: value.name,
    instanceId: value.instanceId,
    generation: value.generation,
    bytes,
  };
}

function transact(database, mode, action) {
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let failure;
    try {
      transaction = database.transaction([STORE], mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new Error("Direct B storage transaction aborted."),
        );
      const guard =
        (callback) =>
        (...args) => {
          try {
            callback(...args);
          } catch (error) {
            failure = error;
            try {
              transaction.abort();
            } catch {}
          }
        };
      action(
        transaction,
        (value) => {
          result = value;
        },
        guard,
      );
    } catch (error) {
      if (transaction) {
        failure = error;
        try {
          transaction.abort();
        } catch {
          reject(error);
        }
      } else reject(error);
    }
  });
}

function openDatabase(indexedDB, name, onBlocked) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let failure;
    request.onblocked = () => onBlocked?.();
    request.onerror = () => reject(failure ?? request.error);
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(STORE))
          request.result.createObjectStore(STORE, { keyPath: "slot" });
      } catch (error) {
        failure = error;
        request.transaction.abort();
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

function readRecord(database, slot) {
  return transact(database, "readonly", (transaction, done, guard) => {
    const request = transaction.objectStore(STORE).get(slot);
    request.onsuccess = guard(() => done(request.result));
  }).then((value) => validateRecord(value, slot));
}

function writeInitial(database, record) {
  return transact(database, "readwrite", (transaction, done, guard) => {
    const store = transaction.objectStore(STORE);
    const request = store.get(record.slot);
    request.onsuccess = guard(() => {
      const current = request.result;
      if (current === undefined) store.put(record);
      done(current === undefined ? record : current);
    });
  });
}

async function chooseLease(selection, locks) {
  const candidates =
    selection === "auto"
      ? Array.from({ length: DIRECT_B_SLOT_COUNT }, (_, index) => index + 1)
      : [slotNumber(selection)];
  for (const number of candidates) {
    const lease = await acquireDiskWriter({
      locks,
      name: `triptych-direct-b:v1:B${number}`,
    });
    if (lease.owned) return { number, lease };
    if (selection !== "auto") return { number, lease };
    await lease.release();
  }
  // No slot is currently writable. Keep a read-only lease on B1 so the
  // fallback remains deterministic; a later explicit reload can retry.
  return {
    number: 1,
    lease: await acquireDiskWriter({
      locks,
      name: "triptych-direct-b:v1:B1",
    }),
  };
}

function randomIdentity(crypto) {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  throw new Error("Direct B storage: secure tab identity unavailable.");
}

/** Open one persistent browser-local B slot for a direct software launch. */
export async function openDirectBSlot({
  selection = "B1",
  indexedDB = globalThis.indexedDB,
  locks = globalThis.navigator?.locks,
  crypto = globalThis.crypto,
  createBlank = () => new Uint8Array(DIRECT_B_BYTES),
  onBlocked,
  onChanged = () => {},
  name = DIRECT_B_DATABASE,
} = {}) {
  const parsed = parseDirectBSelection(selection);
  requireValue(indexedDB, "browser storage unavailable");
  requireValue(
    typeof createBlank === "function",
    "blank-disk factory required",
  );
  const chosen = await chooseLease(parsed, locks);
  let database;
  let channel;
  try {
    database = await openDatabase(indexedDB, name, onBlocked);
    let record = await readRecord(database, chosen.number);
    let persisted = true;
    if (!record) {
      const bytes = copyBytes(await createBlank());
      requireValue(
        bytes.length === DIRECT_B_BYTES,
        "blank disk has invalid size",
      );
      const candidate = {
        slot: chosen.number,
        name: `B${chosen.number}`,
        instanceId: randomIdentity(crypto),
        generation: 1,
        bytes,
      };
      if (chosen.lease.owned) {
        record = validateRecord(
          await writeInitial(database, candidate),
          chosen.number,
        );
      } else {
        // A read-only tab can still display an uninitialised slot. It cannot
        // publish this ephemeral copy until it has reacquired the slot.
        record = candidate;
        persisted = false;
      }
    }

    const tabId = randomIdentity(crypto);
    channel =
      typeof globalThis.BroadcastChannel === "function"
        ? new BroadcastChannel("triptych-direct-b-v1")
        : undefined;
    if (channel) {
      channel.onmessage = (event) => {
        const value = event.data;
        if (
          !value ||
          value.kind !== "saved" ||
          value.sender === tabId ||
          value.slot !== chosen.number ||
          value.generation <= record.generation
        )
          return;
        try {
          onChanged({
            slot: `B${chosen.number}`,
            generation: value.generation,
          });
        } catch (error) {
          queueMicrotask(() => {
            throw error;
          });
        }
      };
    }

    let generation = record.generation;
    let currentBytes = Uint8Array.from(record.bytes);
    let queue = Promise.resolve();
    const publish = (value) => {
      const candidate = copyBytes(value);
      requireValue(candidate.length === DIRECT_B_BYTES, "invalid save size");
      const operation = queue.then(async () => {
        requireValue(chosen.lease.owned, "this B slot is read-only");
        const next = await transact(
          database,
          "readwrite",
          (transaction, done, guard) => {
            const store = transaction.objectStore(STORE);
            const request = store.get(chosen.number);
            request.onsuccess = guard(() => {
              const current = validateRecord(request.result, chosen.number);
              requireValue(
                current?.generation === generation,
                "slot changed in another tab; reload before saving",
              );
              const after = {
                slot: chosen.number,
                name: current.name,
                instanceId: current.instanceId,
                generation: generation + 1,
                bytes: candidate,
              };
              store.put(after);
              done(after);
            });
          },
        );
        const saved = validateRecord(next, chosen.number);
        generation = saved.generation;
        currentBytes = Uint8Array.from(saved.bytes);
        persisted = true;
        channel?.postMessage({
          kind: "saved",
          sender: tabId,
          slot: chosen.number,
          generation,
        });
        return { slot: `B${chosen.number}`, generation };
      });
      queue = operation.catch(() => {});
      return operation;
    };

    const reset = (value) => {
      const blank = copyBytes(value);
      requireValue(blank.length === DIRECT_B_BYTES, "invalid reset size");
      const operation = queue.then(async () => {
        requireValue(chosen.lease.owned, "this B slot is read-only");
        const next = await transact(
          database,
          "readwrite",
          (transaction, done, guard) => {
            const store = transaction.objectStore(STORE);
            const request = store.get(chosen.number);
            request.onsuccess = guard(() => {
              const current = validateRecord(request.result, chosen.number);
              requireValue(
                current?.generation === generation,
                "slot changed in another tab; reload before resetting",
              );
              const after = {
                slot: chosen.number,
                name: current.name,
                instanceId: current.instanceId,
                generation: generation + 1,
                bytes: blank,
              };
              store.put(after);
              done(after);
            });
          },
        );
        const saved = validateRecord(next, chosen.number);
        generation = saved.generation;
        currentBytes = Uint8Array.from(saved.bytes);
        persisted = true;
        channel?.postMessage({
          kind: "saved",
          sender: tabId,
          slot: chosen.number,
          generation,
        });
        return { slot: `B${chosen.number}`, generation };
      });
      queue = operation.catch(() => {});
      return operation;
    };

    return {
      slot: `B${chosen.number}`,
      slotNumber: chosen.number,
      name: record.name,
      instanceId: record.instanceId,
      get bytes() {
        return Uint8Array.from(currentBytes);
      },
      get generation() {
        return generation;
      },
      get persisted() {
        return persisted;
      },
      get writable() {
        return chosen.lease.owned;
      },
      save: publish,
      reset,
      async close() {
        channel?.close();
        database.close();
        await chosen.lease.release();
      },
    };
  } catch (error) {
    channel?.close();
    database?.close();
    await chosen.lease.release();
    throw error;
  }
}
