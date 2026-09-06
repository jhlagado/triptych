import {
  copyDriveSet,
  prepareDriveSet,
  restoreDriveSet,
  validateDriveSetManifest,
} from "./drive-set.js";
import {
  validateWorkingDiskRecord,
  WORKING_DISK_SCHEMA,
} from "./working-disk-store.js";

const STATE = "drive-set-state";
const BLOBS = "drive-set-blobs";
const V2 = "disk-revisions";
const V1 = "working-disks";
const HASH = /^[a-f0-9]{64}$/;
const isHash = (value) => typeof value === "string" && HASH.test(value);

const sameBytes = (a, b) =>
  a instanceof Uint8Array &&
  b instanceof Uint8Array &&
  a.length === b.length &&
  a.every((byte, index) => byte === b[index]);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const message = (error) => String(error?.message ?? error);

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid drive-set revision.");
  return value;
}

function operation(value) {
  if (typeof value !== "string" || !value.length || value.length > 256)
    throw new Error("Invalid drive-set operation identity.");
  return value;
}

function token(value) {
  if (value?.kind === "empty") return { kind: "empty" };
  if (value?.kind === "v3")
    return { kind: "v3", revision: revision(value.revision) };
  if (value?.kind === "legacy" && isHash(value.identity))
    return { kind: "legacy", identity: value.identity };
  throw new Error("Invalid expected drive-set token.");
}

function receipt(value) {
  if (!isHash(value?.digest)) throw new Error("Invalid drive-set digest.");
  return {
    revision: revision(value.revision),
    operationId: operation(value.operationId),
    digest: value.digest,
  };
}

function head(value) {
  if (value?.key !== "head") throw new Error("Invalid drive-set head.");
  return {
    ...receipt(value),
    manifest: validateDriveSetManifest(value.manifest),
  };
}

function backup(value) {
  const id = operation(value?.operationId);
  if (value.key !== `backup:${id}`)
    throw new Error("Invalid drive-set backup.");
  return {
    operationId: id,
    revision: revision(value.revision),
    manifest: validateDriveSetManifest(value.manifest),
  };
}

function references(manifest) {
  return [
    manifest.bootstrap.image,
    manifest.drives.A.image,
    ...(manifest.drives.B ? [manifest.drives.B.image] : []),
  ];
}

function legacy(raw, store) {
  if (
    store === V2 &&
    (raw?.schema !== "triptych-working-disk-v2" || raw?.recovery)
  )
    throw new Error("Saved version-2 disk requires recovery.");
  const disk = validateWorkingDiskRecord(
    store === V1
      ? raw
      : {
          ...raw,
          schema: WORKING_DISK_SCHEMA,
          key: "drive-a",
        },
  );
  if (!disk) throw new Error("Missing legacy disk.");
  return {
    store,
    schema: raw.schema,
    key: raw.key,
    revision: store === V2 ? revision(raw.revision) : 1,
    operationId: store === V2 ? operation(raw.operationId) : "legacy-v1",
    ...disk,
  };
}

// Hashing/fetching never runs in this callback graph. Completion is observed at
// transaction level, including asynchronous constraint and quota failures.
function transact(database, stores, mode, action) {
  return new Promise((resolve, reject) => {
    let failure, result;
    try {
      const tx = database.transaction(stores, mode);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ?? tx.error ?? new Error("Drive-set transaction aborted."),
        );
      const guard =
        (fn) =>
        (...args) => {
          try {
            fn(...args);
          } catch (error) {
            failure ??= error;
            try {
              tx.abort();
            } catch {
              // An externally aborted transaction can throw while a callback is
              // still unwinding. Its terminal abort event remains authoritative.
            }
          }
        };
      guard(() =>
        action(
          tx,
          (value) => {
            result = value;
          },
          guard,
        ),
      )();
    } catch (error) {
      reject(error);
    }
  });
}

function readAuthority(tx, done, guard, withBlobs = false) {
  const get = (store, key, next) => {
    if (!tx.objectStoreNames.contains(store)) {
      next(undefined);
      return;
    }
    const request = tx.objectStore(store).get(key);
    request.onsuccess = guard(() => next(request.result));
  };
  get(STATE, "head", (raw) => {
    if (raw !== undefined) {
      const value = { store: STATE, raw, blobs: new Map() };
      if (withBlobs) {
        for (const ref of references(head(raw).manifest))
          get(BLOBS, ref.sha256, (blob) => {
            if (
              blob?.sha256 !== ref.sha256 ||
              blob.byteLength !== ref.byteLength ||
              !(blob.bytes instanceof Uint8Array) ||
              blob.bytes.length !== ref.byteLength
            )
              throw new Error("Missing or malformed drive-set blob.");
            value.blobs.set(ref.sha256, blob.bytes);
          });
      }
      done(value);
      return;
    }
    get(V2, "head", (old) => {
      if (old !== undefined) {
        done({ store: V2, raw: old });
        return;
      }
      get(V1, "drive-a", (original) =>
        done(original === undefined ? undefined : { store: V1, raw: original }),
      );
    });
  });
}

function sameAuthority(a, b) {
  if (!a || !b) return a === b;
  if (a.store !== b.store) return false;
  if (a.store === STATE) return sameJson(head(a.raw), head(b.raw));
  const left = legacy(a.raw, a.store),
    right = legacy(b.raw, b.store);
  return (
    sameBytes(left.bytes, right.bytes) &&
    sameJson({ ...left, bytes: undefined }, { ...right, bytes: undefined })
  );
}

/** One whole-set CAS/backup boundary. Callers still own the global writer lease,
 * bounded save queue, guest pause and unexecuted-CPU activation discipline. */
export async function openDriveSetStore({
  indexedDB = globalThis.indexedDB,
  name = "triptych-cpu",
  crypto = globalThis.crypto,
  legacyBootstrap,
  onBlocked = () => {},
} = {}) {
  if (!indexedDB)
    throw new Error("This browser does not provide IndexedDB storage.");
  const bootstrap =
    legacyBootstrap === undefined
      ? undefined
      : copyDriveSet({
          bootstrap: { profile: "legacy-e400", bytes: legacyBootstrap },
          drives: {
            A: { name: "validation.img", bytes: new Uint8Array(512) },
            B: null,
          },
        }).bootstrap;
  const database = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 3);
    let upgradeFailure;
    request.onblocked = () =>
      onBlocked("Close older Triptych tabs to upgrade saved-disk storage.");
    request.onerror = () => reject(upgradeFailure ?? request.error);
    request.onupgradeneeded = () => {
      try {
        const db = request.result;
        if (!db.objectStoreNames.contains(BLOBS))
          db.createObjectStore(BLOBS, { keyPath: "sha256" });
        if (!db.objectStoreNames.contains(STATE))
          db.createObjectStore(STATE, { keyPath: "key" });
      } catch (error) {
        upgradeFailure = error;
        request.transaction.abort();
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  const stores = [STATE, BLOBS, V2, V1].filter((store) =>
    database.objectStoreNames.contains(store),
  );
  const read = (store, key) => {
    if (![STATE, BLOBS, V2, V1].includes(store))
      throw new Error("Unknown recovery store.");
    if (!database.objectStoreNames.contains(store))
      return Promise.resolve(undefined);
    return transact(database, store, "readonly", (tx, done, guard) => {
      const request = tx.objectStore(store).get(key);
      request.onsuccess = guard(() => done(request.result));
    });
  };
  async function current() {
    const evidence = await transact(
      database,
      stores,
      "readonly",
      (tx, done, guard) => readAuthority(tx, done, guard, true),
    );
    if (!evidence) return { kind: "empty", token: { kind: "empty" }, evidence };
    if (evidence.store === STATE) {
      const value = head(evidence.raw);
      const snapshot = await restoreDriveSet(
        value.manifest,
        evidence.blobs,
        crypto,
      );
      const prepared = await prepareDriveSet(snapshot, crypto);
      if (prepared.digest !== value.digest)
        throw new Error("Drive-set head digest mismatch.");
      return {
        kind: "ready",
        token: { kind: "v3", revision: value.revision },
        snapshot,
        receipt: receipt(value),
        manifest: value.manifest,
        preparedBlobs: prepared.blobs,
        revision: value.revision,
        evidence,
      };
    }
    if (!bootstrap)
      throw new Error(
        "Historical bootstrap is required to reopen the saved legacy disk.",
      );
    const value = legacy(evidence.raw, evidence.store);
    const prepared = await prepareDriveSet(
      {
        bootstrap,
        drives: { A: { name: value.name, bytes: value.bytes }, B: null },
      },
      crypto,
    );
    const metadata = {
      store: value.store,
      schema: value.schema,
      key: value.key,
      revision: value.revision,
      operationId: value.operationId,
      digest: prepared.digest,
    };
    const hash = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(metadata)),
    );
    const identity = Array.from(new Uint8Array(hash), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return {
      kind: "ready",
      token: { kind: "legacy", identity },
      snapshot: prepared.snapshot,
      manifest: prepared.manifest,
      preparedBlobs: prepared.blobs,
      revision: value.revision,
      evidence,
    };
  }

  // Only head and backup manifests own blobs. Receipts intentionally contain no
  // image roots. A malformed root (or missing referenced key) suspends cleanup;
  // never guess reachability or prune legacy records/backups to admit a write.
  function collect(tx, guard) {
    const roots = new Set();
    let safe = true;
    const scan = tx.objectStore(STATE).openCursor();
    scan.onsuccess = guard(() => {
      const cursor = scan.result;
      if (cursor) {
        try {
          const value =
            cursor.key === "head"
              ? head(cursor.value)
              : typeof cursor.key === "string" &&
                  cursor.key.startsWith("backup:")
                ? backup(cursor.value)
                : undefined;
          if (value)
            for (const ref of references(value.manifest)) roots.add(ref.sha256);
        } catch {
          safe = false;
        }
        cursor.continue();
        return;
      }
      if (!safe) return;
      let remaining = roots.size;
      const prune = () => {
        if (!safe || remaining) return;
        const keys = tx.objectStore(BLOBS).openKeyCursor();
        keys.onsuccess = guard(() => {
          const key = keys.result;
          if (!key) return;
          if (!roots.has(key.key)) tx.objectStore(BLOBS).delete(key.key);
          key.continue();
        });
      };
      if (!remaining) {
        prune();
        return;
      }
      for (const key of roots) {
        const exists = tx.objectStore(BLOBS).getKey(key);
        exists.onsuccess = guard(() => {
          if (exists.result === undefined) safe = false;
          remaining--;
          prune();
        });
      }
    });
  }

  async function publish(expected, operationId, value, manual) {
    const expectedToken = token(expected);
    if (manual) operation(operationId);
    const captured = copyDriveSet(value);
    const prepared = await prepareDriveSet(captured, crypto);
    const before = await current();
    return transact(database, stores, "readwrite", (tx, done, guard) => {
      const state = tx.objectStore(STATE),
        blobs = tx.objectStore(BLOBS);
      const write = () =>
        readAuthority(
          tx,
          (actual) => {
            if (
              !sameAuthority(before.evidence, actual) ||
              !sameJson(expectedToken, before.token)
            )
              throw new Error(
                "Stale drive-set revision; reload the committed set.",
              );
            const next = (before.revision ?? 0) + 1;
            revision(next);
            const result = {
              revision: next,
              operationId: manual ? operationId : `checkpoint:${next}`,
              digest: prepared.digest,
            };
            // A legacy predecessor must become a v3 backup without altering its
            // original store. Install its blobs along with the new candidate.
            const publishHead = () => {
              if (manual && before.kind === "ready")
                state.add({
                  key: `backup:${operationId}`,
                  operationId,
                  revision: before.revision,
                  manifest: before.manifest,
                });
              if (manual)
                state.add({
                  key: `operation:${operationId}`,
                  expected: expectedToken,
                  digest: prepared.digest,
                  receipt: result,
                });
              state.put({
                key: "head",
                ...result,
                manifest: prepared.manifest,
              });
              collect(tx, guard);
              done(result);
            };
            const pending = new Map(
              prepared.blobs.map((blob) => [blob.sha256, blob]),
            );
            if (manual && before.kind === "ready")
              for (const blob of before.preparedBlobs ?? [])
                pending.set(blob.sha256, blob);
            let remaining = pending.size;
            if (!remaining) {
              publishHead();
              return;
            }
            for (const blob of pending.values()) {
              const get = blobs.get(blob.sha256);
              get.onsuccess = guard(() => {
                if (get.result !== undefined) {
                  if (
                    get.result.sha256 !== blob.sha256 ||
                    get.result.byteLength !== blob.bytes.length ||
                    !sameBytes(get.result.bytes, blob.bytes)
                  )
                    throw new Error(
                      "Immutable drive-set blob collision or corruption.",
                    );
                } else
                  blobs.add({
                    sha256: blob.sha256,
                    byteLength: blob.bytes.length,
                    bytes: blob.bytes,
                  });
                if (--remaining === 0) publishHead();
              });
            }
          },
          guard,
        );
      if (!manual) {
        write();
        return;
      }
      const previous = state.get(`operation:${operationId}`);
      previous.onsuccess = guard(() => {
        const old = previous.result;
        if (old === undefined) {
          write();
          return;
        }
        const result = receipt(old.receipt);
        if (
          old.key !== `operation:${operationId}` ||
          result.operationId !== operationId ||
          !sameJson(token(old.expected), expectedToken) ||
          old.digest !== prepared.digest ||
          result.digest !== prepared.digest
        )
          throw new Error(
            "Drive-set operation identity was already used for a different change.",
          );
        done(result);
      });
    });
  }

  async function restoreManifest(manifest) {
    const validated = validateDriveSetManifest(manifest);
    const blobs = await transact(
      database,
      BLOBS,
      "readonly",
      (tx, done, guard) => {
        const result = new Map();
        for (const ref of references(validated)) {
          const request = tx.objectStore(BLOBS).get(ref.sha256);
          request.onsuccess = guard(() => {
            const blob = request.result;
            if (
              blob?.sha256 !== ref.sha256 ||
              blob.byteLength !== ref.byteLength
            )
              throw new Error("Missing or malformed backup blob.");
            result.set(ref.sha256, blob.bytes);
          });
        }
        done(result);
      },
    );
    return restoreDriveSet(validated, blobs, crypto);
  }

  return {
    async load() {
      try {
        const value = await current();
        return value.kind === "empty"
          ? { kind: "empty", token: value.token }
          : {
              kind: "ready",
              token: value.token,
              snapshot: value.snapshot,
              ...(value.receipt ? { receipt: value.receipt } : {}),
            };
      } catch (error) {
        return { kind: "recovery", error: message(error) };
      }
    },
    saveCheckpoint: (expected, snapshot) =>
      publish(expected, undefined, snapshot, false),
    async commitChange(expected, operationId, snapshot) {
      return publish(expected, operationId, snapshot, true);
    },
    readRawRecovery: read,
    // Listing validates metadata only; readBackup verifies every referenced byte
    // before its snapshot can be staged. Do not eagerly clone all backup images.
    async listBackups() {
      const available = [STATE, V2].filter((store) =>
        database.objectStoreNames.contains(store),
      );
      return transact(database, available, "readonly", (tx, done, guard) => {
        const result = [];
        for (const store of available) {
          const request = tx.objectStore(store).openCursor();
          request.onsuccess = guard(() => {
            const cursor = request.result;
            if (!cursor) return;
            const prefix = store === STATE ? "backup:" : "change:";
            if (
              typeof cursor.key === "string" &&
              cursor.key.startsWith(prefix)
            ) {
              const id = `${store === STATE ? "v3" : "v2"}:${cursor.key.slice(prefix.length)}`;
              try {
                if (store === V2 && cursor.value.before === undefined) {
                  cursor.continue();
                  return;
                }
                const value =
                  store === STATE
                    ? backup(cursor.value)
                    : legacy(
                        {
                          ...cursor.value.before,
                          schema: "triptych-working-disk-v2",
                        },
                        V2,
                      );
                result.push({
                  id,
                  kind: "available",
                  revision: value.revision,
                  operationId: cursor.key.slice(prefix.length),
                });
              } catch (error) {
                result.push({ id, kind: "recovery", error: message(error) });
              }
            }
            cursor.continue();
          });
        }
        done(result);
      });
    },
    async readBackup(id) {
      if (typeof id !== "string") throw new Error("Invalid backup identity.");
      if (id.startsWith("v3:")) {
        const value = await read(STATE, `backup:${id.slice(3)}`);
        return value === undefined
          ? undefined
          : restoreManifest(backup(value).manifest);
      }
      if (id.startsWith("v2:")) {
        const value = await read(V2, `change:${id.slice(3)}`);
        if (value === undefined || value.before === undefined) return undefined;
        if (!bootstrap)
          throw new Error(
            "Historical bootstrap is required to reopen a legacy backup.",
          );
        const disk = legacy(
          { ...value.before, schema: "triptych-working-disk-v2" },
          V2,
        );
        return copyDriveSet({
          bootstrap,
          drives: { A: { name: disk.name, bytes: disk.bytes }, B: null },
        });
      }
      throw new Error("Invalid backup identity.");
    },
    close() {
      database.close();
    },
  };
}
