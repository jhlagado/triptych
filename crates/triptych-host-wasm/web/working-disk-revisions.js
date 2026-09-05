import {
  validateWorkingDiskRecord,
  WORKING_DISK_SCHEMA,
} from "./working-disk-store.js";

const STORE = "disk-revisions";
const LEGACY_STORE = "working-disks";
const SCHEMA = "triptych-working-disk-v2";

function snapshot(value) {
  return validateWorkingDiskRecord({
    schema: WORKING_DISK_SCHEMA,
    key: "drive-a",
    name: value?.name,
    bytes: value?.bytes,
  });
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Invalid disk revision.");
  return value;
}

function head(value) {
  if (value === undefined) return undefined;
  if (value?.recovery)
    throw new Error(`Saved disk requires recovery: ${value.error}`);
  if (
    value?.schema !== SCHEMA ||
    revision(value.revision) === 0 ||
    typeof value.operationId !== "string"
  ) {
    throw new Error("Invalid revisioned working disk.");
  }
  return {
    ...snapshot(value),
    revision: value.revision,
    operationId: value.operationId,
  };
}

function sameSnapshot(a, b) {
  return (
    a.name === b.name &&
    a.bytes.length === b.bytes.length &&
    a.bytes.every((byte, index) => byte === b.bytes[index])
  );
}

// A single terminal promise observes each transaction, including request failures.
// All continuations enqueue IDB work synchronously; never await network/crypto here.
function transact(database, stores, mode, action) {
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let failure;
    try {
      transaction = database.transaction(stores, mode);
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () =>
        reject(
          failure ??
            transaction.error ??
            new Error("Disk transaction aborted."),
        );
      const guarded = (callback) => (event) => {
        try {
          callback(event);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      guarded(() =>
        action(
          transaction,
          (value) => {
            result = value;
          },
          guarded,
        ),
      )();
    } catch (error) {
      reject(error);
    }
  });
}

/** Transaction layer only. The caller must own the exclusive browser session
 * lock and serialize autosaves with manual changes. CAS is an additional guard,
 * not permission to replace a running guest's disk. The workspace coordinator
 * supplies the guest pause and fresh-machine activation boundary.
 */
export async function openRevisionedDiskStore({
  indexedDB = globalThis.indexedDB,
  name = "triptych-cpu",
  onBlocked = () => {},
} = {}) {
  if (!indexedDB)
    throw new Error("This browser does not provide IndexedDB storage.");
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 2);
    let upgradeFailure;
    const guardUpgrade = (callback) => () => {
      try {
        callback();
      } catch (error) {
        upgradeFailure ??= error;
        // Opening rejects only after the versionchange transaction has rolled
        // back. Preserve its original cause instead of leaking a page error.
        try {
          request.transaction.abort();
        } catch {
          // A request failure may already have aborted the transaction.
        }
      }
    };
    request.onblocked = () =>
      onBlocked("Close older Triptych tabs to upgrade saved-disk storage.");
    request.onerror = () => reject(upgradeFailure ?? request.error);
    request.onupgradeneeded = guardUpgrade(() => {
      request.transaction.addEventListener("error", (event) => {
        upgradeFailure ??= event.target.error;
      });
      const db = request.result;
      if (!db.objectStoreNames.contains(LEGACY_STORE))
        db.createObjectStore(LEGACY_STORE, { keyPath: "key" });
      const target = db.createObjectStore(STORE, { keyPath: "key" });
      const read = request.transaction.objectStore(LEGACY_STORE).get("drive-a");
      read.onsuccess = guardUpgrade(() => {
        if (read.result === undefined) return;
        let record;
        try {
          record = {
            ...validateWorkingDiskRecord(read.result),
            schema: SCHEMA,
            key: "head",
            revision: 1,
            operationId: "legacy-v1",
          };
        } catch (error) {
          // Leave the original record untouched and fail closed, including saves.
          record = {
            key: "head",
            recovery: true,
            error: String(error.message ?? error),
          };
        }
        target.put(record);
      });
    });
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });

  const read = (store, key) =>
    transact(database, store, "readonly", (tx, done, guard) => {
      const request = tx.objectStore(store).get(key);
      request.onsuccess = guard(() => done(request.result));
    });

  function publish(expectedRevision, operationId, value, manual) {
    revision(expectedRevision);
    if (expectedRevision === Number.MAX_SAFE_INTEGER)
      throw new Error("Disk revision limit reached.");
    const candidate = snapshot(value);
    if (
      manual &&
      (typeof operationId !== "string" ||
        operationId.length === 0 ||
        operationId.length > 256)
    )
      throw new Error("Invalid disk operation identity.");
    return transact(database, STORE, "readwrite", (tx, done, guard) => {
      const store = tx.objectStore(STORE);
      const publishHead = () => {
        const request = store.get("head");
        request.onsuccess = guard(() => {
          const before = head(request.result);
          if ((before?.revision ?? 0) !== expectedRevision)
            throw new Error("Stale disk revision; reload the committed disk.");
          const after = {
            ...candidate,
            revision: expectedRevision + 1,
            operationId: manual
              ? operationId
              : `checkpoint:${expectedRevision + 1}`,
          };
          store.put({ ...after, schema: SCHEMA, key: "head" });
          if (manual)
            store.add({
              key: `change:${operationId}`,
              expectedRevision,
              before,
              after,
            });
          done(after);
        });
      };
      if (!manual) {
        publishHead();
        return;
      }
      const previous = store.get(`change:${operationId}`);
      previous.onsuccess = guard(() => {
        const change = previous.result;
        if (change === undefined) {
          publishHead();
          return;
        }
        const after = head({ ...change.after, schema: SCHEMA });
        if (
          change.expectedRevision !== expectedRevision ||
          !sameSnapshot(after, candidate)
        )
          throw new Error(
            "Disk operation identity was already used for a different change.",
          );
        // Return the original receipt, never restore it over a newer head.
        done(after);
      });
    });
  }

  return {
    async load() {
      return head(await read(STORE, "head"));
    },
    async loadLegacyRecord() {
      return read(LEGACY_STORE, "drive-a");
    },
    async saveCheckpoint(expectedRevision, value) {
      return publish(expectedRevision, undefined, value, false);
    },
    async commitChange(expectedRevision, operationId, value) {
      return publish(expectedRevision, operationId, value, true);
    },
    async listBackups() {
      return transact(database, STORE, "readonly", (tx, done, guard) => {
        const backups = [];
        const request = tx.objectStore(STORE).openCursor();
        request.onsuccess = guard(() => {
          const cursor = request.result;
          if (!cursor) {
            done(backups.sort((a, b) => b.revision - a.revision));
            return;
          }
          if (cursor.key.startsWith("change:") && cursor.value.before) {
            const before = head({ ...cursor.value.before, schema: SCHEMA });
            backups.push({
              operationId: cursor.value.after.operationId,
              name: before.name,
              revision: before.revision,
              bytes: before.bytes.length,
            });
          }
          cursor.continue();
        });
      });
    },
    async readBackup(operationId) {
      const change = await read(STORE, `change:${operationId}`);
      return change?.before
        ? head({ ...change.before, schema: SCHEMA })
        : undefined;
    },
    close() {
      database.close();
    },
  };
}
