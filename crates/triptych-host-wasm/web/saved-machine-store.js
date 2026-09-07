import {
  prepareSavedMachine,
  restoreSavedMachine,
  validateSavedMachineManifest,
  savedMachineReferences,
} from "./saved-machine.js";
import { copyDriveSet, validateDriveSetManifest } from "./drive-set.js";
import {
  validateWorkingDiskRecord,
  WORKING_DISK_SCHEMA,
} from "./working-disk-store.js";

const STATE = "drive-set-state-v4",
  BLOBS = "drive-set-blobs-v4";
const V3 = "drive-set-state",
  OLD_BLOBS = "drive-set-blobs",
  V2 = "disk-revisions",
  V1 = "working-disks";
const MARKER = { key: "activation", schema: "triptych-drive-set-authority-v4" };
const STORES = [STATE, BLOBS, V3, OLD_BLOBS, V2, V1];
const isHash = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const message = (error) => String(error?.message ?? error);
function requireValue(condition, description) {
  if (!condition) throw new Error(`Saved machine store: ${description}.`);
}
function fields(value, keys) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Reflect.ownKeys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    "invalid record fields",
  );
}
function revision(value) {
  requireValue(Number.isSafeInteger(value) && value > 0, "invalid revision");
  return value;
}
function operation(value) {
  requireValue(
    typeof value === "string" && value.length > 0 && value.length <= 256,
    "invalid operation identity",
  );
  return value;
}
function token(value) {
  if (value?.kind === "empty") {
    fields(value, ["kind"]);
    return { kind: "empty" };
  }
  if (value?.kind === "v4") {
    fields(value, ["kind", "revision", "digest"]);
    requireValue(isHash(value.digest), "invalid token digest");
    return {
      kind: "v4",
      revision: revision(value.revision),
      digest: value.digest,
    };
  }
  fields(value, ["kind", "store", "identity"]);
  requireValue(
    value.kind === "historical" &&
      [V3, V2, V1].includes(value.store) &&
      isHash(value.identity),
    "invalid historical token",
  );
  return { kind: "historical", store: value.store, identity: value.identity };
}
function receipt(value) {
  fields(value, ["authority", "revision", "operationId", "digest"]);
  requireValue(
    value.authority === "v4" && isHash(value.digest),
    "invalid receipt",
  );
  return {
    authority: "v4",
    revision: revision(value.revision),
    operationId: operation(value.operationId),
    digest: value.digest,
  };
}
function operationRecord(value) {
  fields(value, ["key", "expected", "digest", "receipt"]);
  const result = receipt(value.receipt);
  const expected = token(value.expected);
  requireValue(
    value.key === `operation:${result.operationId}` &&
      value.digest === result.digest,
    "invalid operation binding",
  );
  requireValue(
    expected.kind === "historical" ||
      (expected.kind === "empty"
        ? result.revision === 1
        : Number.isSafeInteger(expected.revision + 1) &&
          result.revision === expected.revision + 1),
    "impossible operation revision transition",
  );
  return {
    key: value.key,
    expected,
    digest: value.digest,
    receipt: result,
  };
}
function envelope(value, isBackup = false) {
  fields(value, ["key", "revision", "operationId", "digest", "manifest"]);
  const operationId = operation(value.operationId);
  requireValue(
    value.key === (isBackup ? `backup:${operationId}` : "head") &&
      isHash(value.digest),
    "invalid head or backup",
  );
  return {
    key: value.key,
    revision: revision(value.revision),
    operationId,
    digest: value.digest,
    manifest: validateSavedMachineManifest(value.manifest),
  };
}
function oldHead(value) {
  requireValue(
    value?.key === "head" && isHash(value.digest),
    "invalid historical head",
  );
  return {
    key: "head",
    revision: revision(value.revision),
    operationId: operation(value.operationId),
    digest: value.digest,
    manifest: validateDriveSetManifest(value.manifest),
  };
}
function oldBackup(value) {
  requireValue(
    value?.key === `backup:${operation(value?.operationId)}`,
    "invalid historical backup",
  );
  return {
    revision: revision(value.revision),
    operationId: value.operationId,
    manifest: validateDriveSetManifest(value.manifest),
  };
}
function legacy(raw, store) {
  requireValue(
    store !== V2 ||
      (raw?.schema === "triptych-working-disk-v2" && !raw.recovery),
    "historical disk requires recovery",
  );
  const disk = validateWorkingDiskRecord(
    store === V1
      ? raw
      : { ...raw, schema: WORKING_DISK_SCHEMA, key: "drive-a" },
  );
  requireValue(disk, "missing historical disk");
  return {
    ...disk,
    revision: store === V2 ? revision(raw.revision) : 1,
    operationId: store === V2 ? operation(raw.operationId) : "legacy-v1",
  };
}
// Compare captured evidence, including every byte and metadata field. In
// particular a historical blob replacement cannot hide behind an unchanged head.
function same(a, b) {
  if (a === b) return true;
  if (a instanceof Uint8Array || b instanceof Uint8Array)
    return (
      a instanceof Uint8Array &&
      b instanceof Uint8Array &&
      a.length === b.length &&
      a.every((byte, i) => byte === b[i])
    );
  if (a instanceof ArrayBuffer || b instanceof ArrayBuffer)
    return (
      a instanceof ArrayBuffer &&
      b instanceof ArrayBuffer &&
      same(new Uint8Array(a), new Uint8Array(b))
    );
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b))
    return (
      ArrayBuffer.isView(a) &&
      ArrayBuffer.isView(b) &&
      same(
        new Uint8Array(a.buffer, a.byteOffset, a.byteLength),
        new Uint8Array(b.buffer, b.byteOffset, b.byteLength),
      )
    );
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (a instanceof Map || b instanceof Map)
    return (
      a instanceof Map &&
      b instanceof Map &&
      a.size === b.size &&
      [...a].every(([key, value]) => b.has(key) && same(value, b.get(key)))
    );
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}
async function hash(value, crypto) {
  requireValue(crypto?.subtle, "SHA-256 unavailable");
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}
async function verifyDigest(value, crypto) {
  requireValue(
    (await hash(value.manifest, crypto)) === value.digest,
    "manifest digest mismatch",
  );
}

// No promises, hashing, or external work inside this callback graph. Only the
// transaction's completion event acknowledges publication; request success does not.
function transact(database, stores, mode, action) {
  return new Promise((resolve, reject) => {
    let failure, result;
    try {
      const tx = database.transaction(stores, mode);
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ??
            tx.error ??
            new Error("Saved-machine transaction aborted."),
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
              /* Terminal abort remains authoritative. */
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
function get(tx, store, key, done, guard) {
  if (!tx.objectStoreNames.contains(store)) {
    done(undefined);
    return;
  }
  const request = tx.objectStore(store).get(key);
  request.onsuccess = guard(() => done(request.result));
}
function readBlobs(tx, store, manifest, done, guard) {
  const refs = savedMachineReferences(manifest),
    result = new Map();
  let remaining = refs.length;
  for (const ref of refs)
    get(
      tx,
      store,
      ref.sha256,
      (raw) => {
        requireValue(
          raw?.sha256 === ref.sha256 &&
            raw.byteLength === ref.byteLength &&
            raw.bytes instanceof Uint8Array &&
            raw.bytes.length === ref.byteLength,
          "missing or malformed image blob",
        );
        result.set(ref.sha256, raw);
        // Never call done until the LAST blob callback has populated the evidence.
        if (--remaining === 0) done(result);
      },
      guard,
    );
}
function readAuthority(tx, done, guard) {
  const request = tx.objectStore(STATE).getAll();
  request.onsuccess = guard(() => {
    const rows = request.result;
    const marker = rows.find((row) => row.key === "activation"),
      raw = rows.find((row) => row.key === "head");
    if (rows.length) {
      fields(marker, ["key", "schema"]);
      requireValue(same(marker, MARKER), "invalid activation marker");
      requireValue(
        rows.every(
          (row) =>
            row.key === "activation" ||
            row.key === "head" ||
            (typeof row.key === "string" &&
              (row.key.startsWith("backup:") ||
                row.key.startsWith("operation:"))),
        ),
        "unexplained authority record",
      );
      // Only malformed backups have the explicit recovery/GC exception.
      // Unknown or corrupt operation metadata cannot be silently interpreted as
      // a receipt from this authority, even when a different ID is being saved.
      const value = envelope(raw);
      for (const row of rows) {
        if (!row.key.startsWith("operation:")) continue;
        const saved = operationRecord(row).receipt;
        requireValue(
          saved.revision < value.revision ||
            (saved.revision === value.revision &&
              saved.digest === value.digest &&
              saved.operationId === value.operationId),
          "operation receipt disagrees with authoritative head",
        );
      }
      readBlobs(
        tx,
        BLOBS,
        value.manifest,
        (blobs) => done({ store: STATE, raw, rows, blobs }),
        guard,
      );
      return;
    }
    const count = tx.objectStore(BLOBS).count();
    count.onsuccess = guard(() => {
      requireValue(
        count.result === 0,
        "unactivated blob records require recovery",
      );
      get(
        tx,
        V3,
        "head",
        (old) => {
          if (old !== undefined) {
            const value = oldHead(old);
            readBlobs(
              tx,
              OLD_BLOBS,
              value.manifest,
              (blobs) => done({ store: V3, raw: old, rows, blobs }),
              guard,
            );
            return;
          }
          get(
            tx,
            V2,
            "head",
            (v2) => {
              if (v2 !== undefined) {
                legacy(v2, V2);
                done({ store: V2, raw: v2, rows });
                return;
              }
              get(
                tx,
                V1,
                "drive-a",
                (v1) => {
                  if (v1 !== undefined) legacy(v1, V1);
                  done(
                    v1 === undefined
                      ? { store: null, rows }
                      : { store: V1, raw: v1, rows },
                  );
                },
                guard,
              );
            },
            guard,
          );
        },
        guard,
      );
    });
  });
}

/** V4 durable authority, independent of runtime profile admission. Callers own
 * the writer lease, bounded save queue, paused guest and staged CPU activation. */
export async function openSavedMachineStore({
  indexedDB = globalThis.indexedDB,
  name = "triptych-cpu",
  crypto = globalThis.crypto,
  legacyBootstrap,
  onBlocked = () => {},
} = {}) {
  requireValue(indexedDB, "IndexedDB unavailable");
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
    const request = indexedDB.open(name, 4);
    let failure;
    request.onblocked = () =>
      onBlocked("Close older Triptych tabs to upgrade saved-disk storage.");
    request.onerror = () => reject(failure ?? request.error);
    request.onupgradeneeded = () => {
      try {
        for (const [store, keyPath] of [
          [STATE, "key"],
          [BLOBS, "sha256"],
        ])
          if (!request.result.objectStoreNames.contains(store))
            request.result.createObjectStore(store, { keyPath });
      } catch (error) {
        failure = error;
        request.transaction.abort();
      }
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
  const stores = STORES.filter((store) =>
    database.objectStoreNames.contains(store),
  );
  const read = (store, key) => {
    requireValue(STORES.includes(store), "unknown recovery store");
    if (!stores.includes(store)) return Promise.resolve(undefined);
    return transact(database, store, "readonly", (tx, done, guard) =>
      get(tx, store, key, done, guard),
    );
  };
  async function current() {
    const evidence = await transact(
      database,
      stores,
      "readonly",
      readAuthority,
    );
    if (evidence.store === null)
      return { kind: "empty", token: { kind: "empty" }, evidence };
    if ([STATE, V3].includes(evidence.store)) {
      const value =
        evidence.store === STATE
          ? envelope(evidence.raw)
          : oldHead(evidence.raw);
      await verifyDigest(value, crypto);
      const snapshot = await restoreSavedMachine(
        value.manifest,
        new Map([...evidence.blobs].map(([key, raw]) => [key, raw.bytes])),
        crypto,
      );
      const ready = {
        kind: "ready",
        snapshot,
        manifest: value.manifest,
        digest: value.digest,
        revision: value.revision,
        evidence,
        preparedBlobs: [...evidence.blobs].map(([sha256, raw]) => ({
          sha256,
          bytes: raw.bytes,
        })),
      };
      return evidence.store === STATE
        ? {
            ...ready,
            token: {
              kind: "v4",
              revision: value.revision,
              digest: value.digest,
            },
            receipt: {
              authority: "v4",
              revision: value.revision,
              operationId: value.operationId,
              digest: value.digest,
            },
          }
        : {
            ...ready,
            token: {
              kind: "historical",
              store: V3,
              identity: await hash(
                { store: V3, raw: evidence.raw, digest: value.digest },
                crypto,
              ),
            },
          };
    }
    requireValue(bootstrap, "historical bootstrap required");
    const disk = legacy(evidence.raw, evidence.store);
    const prepared = await prepareSavedMachine(
      {
        bootstrap,
        drives: { A: { name: disk.name, bytes: disk.bytes }, B: null },
      },
      crypto,
    );
    const metadata = { ...evidence.raw };
    delete metadata.bytes;
    return {
      kind: "ready",
      token: {
        kind: "historical",
        store: evidence.store,
        identity: await hash(
          { store: evidence.store, metadata, digest: prepared.digest },
          crypto,
        ),
      },
      snapshot: prepared.snapshot,
      manifest: prepared.manifest,
      digest: prepared.digest,
      preparedBlobs: prepared.blobs,
      revision: disk.revision,
      evidence,
    };
  }
  async function gcPlan(rows) {
    const roots = [];
    try {
      for (const row of rows) {
        if (row.key === "head" || row.key.startsWith("backup:")) {
          const value = envelope(row, row.key !== "head");
          await verifyDigest(value, crypto);
          roots.push(value);
        }
      }
      return { safe: true, rows, roots };
    } catch {
      return { safe: false, rows, roots: [] };
    }
  }
  function collect(tx, guard, plan, newHead, newBackup) {
    if (!plan.safe) return;
    // readAuthority already compared all exact rows inside this transaction.
    // Recheck roots once more before deletion, accounting for our own writes.
    const expectedRows = plan.rows.filter((row) => row.key !== "head");
    if (!expectedRows.some((row) => row.key === "activation"))
      expectedRows.push(MARKER);
    expectedRows.push(newHead);
    if (newBackup) expectedRows.push(newBackup);
    const expectedRoots = expectedRows.filter(
      (row) => row.key === "head" || row.key.startsWith("backup:"),
    );
    const scan = tx.objectStore(STATE).getAll();
    scan.onsuccess = guard(() => {
      const roots = scan.result.filter(
        (row) =>
          row.key === "head" ||
          (typeof row.key === "string" && row.key.startsWith("backup:")),
      );
      const order = (rows) =>
        [...rows].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (!same(order(roots), order(expectedRoots))) return;
      const reachable = new Set();
      for (const row of roots)
        for (const ref of savedMachineReferences(row.manifest))
          reachable.add(ref.sha256);
      let remaining = reachable.size,
        safe = true;
      const prune = () => {
        if (remaining || !safe) return;
        const request = tx.objectStore(BLOBS).openKeyCursor();
        request.onsuccess = guard(() => {
          const cursor = request.result;
          if (!cursor) return;
          if (!reachable.has(cursor.key))
            tx.objectStore(BLOBS).delete(cursor.key);
          cursor.continue();
        });
      };
      for (const key of reachable) {
        const request = tx.objectStore(BLOBS).getKey(key);
        request.onsuccess = guard(() => {
          if (request.result === undefined) safe = false;
          remaining--;
          prune();
        });
      }
      prune();
    });
  }
  async function publish(expected, operationId, value, manual) {
    const expectedToken = token(expected);
    if (manual) operation(operationId);
    // prepareSavedMachine captures synchronously. Do not pre-copy a second time.
    const prepared = await prepareSavedMachine(value, crypto);
    const before = await current(); // Strict authority recovery precedes retry lookup.
    const plan = await gcPlan(before.evidence.rows);
    return transact(database, stores, "readwrite", (tx, done, guard) => {
      readAuthority(
        tx,
        (actual) => {
          requireValue(
            same(before.evidence, actual),
            "stale authority evidence; reload",
          );
          const state = tx.objectStore(STATE),
            blobs = tx.objectStore(BLOBS);
          const write = () => {
            requireValue(
              same(expectedToken, before.token),
              "stale revision; reload",
            );
            const next = revision((before.revision ?? 0) + 1),
              id = manual ? operationId : `checkpoint:${next}`;
            const result = {
              authority: "v4",
              revision: next,
              operationId: id,
              digest: prepared.digest,
            };
            const publication = {
              token: { kind: "v4", revision: next, digest: prepared.digest },
              receipt: result,
            };
            const first = actual.store !== STATE;
            const retain = before.kind === "ready" && (first || manual);
            const newBackup = retain
              ? {
                  key: `backup:${id}`,
                  operationId: id,
                  revision: before.revision,
                  digest: before.digest,
                  manifest: before.manifest,
                }
              : undefined;
            const newHead = {
              key: "head",
              revision: next,
              operationId: id,
              digest: prepared.digest,
              manifest: prepared.manifest,
            };
            const pending = new Map();
            for (const blob of [
              ...prepared.blobs,
              ...(retain ? before.preparedBlobs : []),
            ]) {
              const prior = pending.get(blob.sha256);
              requireValue(
                !prior || same(prior.bytes, blob.bytes),
                "candidate/predecessor hash collision",
              );
              pending.set(blob.sha256, blob);
            }
            const publishHead = () => {
              if (first) state.add(MARKER);
              // add, never put: a manual ID colliding with checkpoint:<revision>
              // aborts atomically instead of replacing the predecessor backup.
              if (newBackup) state.add(newBackup);
              if (manual)
                state.add({
                  key: `operation:${id}`,
                  expected: expectedToken,
                  digest: prepared.digest,
                  receipt: result,
                });
              state.put(newHead);
              collect(tx, guard, plan, newHead, newBackup);
              done(publication);
            };
            let remaining = pending.size;
            for (const blob of pending.values())
              get(
                tx,
                BLOBS,
                blob.sha256,
                (raw) => {
                  if (raw !== undefined)
                    requireValue(
                      raw.sha256 === blob.sha256 &&
                        raw.byteLength === blob.bytes.length &&
                        same(raw.bytes, blob.bytes),
                      "immutable blob collision or corruption",
                    );
                  else
                    blobs.add({
                      sha256: blob.sha256,
                      byteLength: blob.bytes.length,
                      bytes: blob.bytes,
                    });
                  if (--remaining === 0) publishHead();
                },
                guard,
              );
          };
          if (!manual) {
            write();
            return;
          }
          get(
            tx,
            STATE,
            `operation:${operationId}`,
            (old) => {
              if (old === undefined) {
                write();
                return;
              }
              const validated = operationRecord(old);
              const result = validated.receipt;
              requireValue(
                result.operationId === operationId &&
                  same(validated.expected, expectedToken) &&
                  validated.digest === prepared.digest &&
                  result.digest === prepared.digest,
                "operation identity already used for a different change",
              );
              done({
                token: {
                  kind: "v4",
                  revision: result.revision,
                  digest: result.digest,
                },
                receipt: result,
              });
            },
            guard,
          );
        },
        guard,
      );
    });
  }
  async function restoreManifest(value, store, verify = true) {
    if (verify) await verifyDigest(value, crypto);
    const images = await transact(
      database,
      store,
      "readonly",
      (tx, done, guard) => readBlobs(tx, store, value.manifest, done, guard),
    );
    return restoreSavedMachine(
      value.manifest,
      new Map([...images].map(([key, raw]) => [key, raw.bytes])),
      crypto,
    );
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
    commitChange: (expected, operationId, snapshot) =>
      publish(expected, operationId, snapshot, true),
    readRawRecovery: read,
    async listBackups() {
      const available = [STATE, V3, V2].filter((store) =>
        stores.includes(store),
      );
      const rows = await transact(
        database,
        available,
        "readonly",
        (tx, done, guard) => {
          const result = [];
          let remaining = available.length;
          for (const store of available) {
            const request = tx.objectStore(store).getAll();
            request.onsuccess = guard(() => {
              result.push(...request.result.map((raw) => ({ store, raw })));
              if (--remaining === 0) done(result);
            });
          }
        },
      );
      const result = [];
      for (const { store, raw } of rows) {
        const prefix = store === V2 ? "change:" : "backup:";
        if (typeof raw.key !== "string" || !raw.key.startsWith(prefix))
          continue;
        if (store === V2 && raw.before === undefined) continue;
        const id = `${store === STATE ? "v4" : store === V3 ? "v3" : "v2"}:${raw.key.slice(prefix.length)}`;
        try {
          const value =
            store === STATE
              ? envelope(raw, true)
              : store === V3
                ? oldBackup(raw)
                : legacy(
                    { ...raw.before, schema: "triptych-working-disk-v2" },
                    V2,
                  );
          if (store === STATE) await verifyDigest(value, crypto);
          result.push({
            id,
            kind: "available",
            revision: value.revision,
            operationId: raw.key.slice(prefix.length),
          });
        } catch (error) {
          result.push({ id, kind: "recovery", error: message(error) });
        }
      }
      return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    },
    async readBackup(id) {
      requireValue(typeof id === "string", "invalid backup identity");
      if (id.startsWith("v4:") || id.startsWith("v3:")) {
        const latest = id.startsWith("v4:"),
          raw = await read(latest ? STATE : V3, `backup:${id.slice(3)}`);
        if (raw === undefined) return undefined;
        return restoreManifest(
          latest ? envelope(raw, true) : oldBackup(raw),
          latest ? BLOBS : OLD_BLOBS,
          latest,
        );
      }
      if (id.startsWith("v2:")) {
        const raw = await read(V2, `change:${id.slice(3)}`);
        if (raw?.before === undefined) return undefined;
        requireValue(bootstrap, "historical bootstrap required");
        const disk = legacy(
          { ...raw.before, schema: "triptych-working-disk-v2" },
          V2,
        );
        return copyDriveSet({
          bootstrap,
          drives: { A: { name: disk.name, bytes: disk.bytes }, B: null },
        });
      }
      throw new Error("Saved machine store: invalid backup identity.");
    },
    close() {
      database.close();
    },
  };
}
