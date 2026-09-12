import {
  prepareDiskBox,
  validateDiskBoxManifest,
  diskBoxReferences,
} from "./disk-box.js";
import { createSavedMachineReader } from "./saved-machine-store.js";

const STATE = "disk-box-state-v1",
  BLOBS = "disk-box-blobs-v1";
const HISTORY = [
  "drive-set-state-v4",
  "drive-set-blobs-v4",
  "drive-set-state",
  "drive-set-blobs",
  "disk-revisions",
  "working-disks",
];
const MARKER = { key: "activation", schema: "triptych-disk-box-authority-v1" };
const HASH = /^[a-f0-9]{64}$/;
const encoder = new TextEncoder();
function requireValue(condition, message) {
  if (!condition) throw new Error(`Disk box store: ${message}.`);
}
function fields(value, keys) {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid record fields",
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requireValue(
    Reflect.ownKeys(descriptors).length === keys.length &&
      keys.every(
        (key) =>
          Object.hasOwn(descriptors, key) &&
          Object.hasOwn(descriptors[key], "value"),
      ),
    "invalid record fields or accessors",
  );
  return Object.fromEntries(keys.map((key) => [key, descriptors[key].value]));
}
function same(a, b) {
  if (Object.is(a, b)) return true;
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
  if (
    !a ||
    !b ||
    typeof a !== "object" ||
    typeof b !== "object" ||
    Array.isArray(a) !== Array.isArray(b)
  )
    return false;
  const keys = Reflect.ownKeys(a);
  return (
    keys.length === Reflect.ownKeys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]))
  );
}
function token(value) {
  if (
    value &&
    typeof value === "object" &&
    Object.getOwnPropertyDescriptor(value, "kind")?.value === "unadopted"
  ) {
    value = fields(value, ["kind", "fingerprint"]);
    requireValue(
      HASH.test(value.fingerprint),
      "invalid historical fingerprint",
    );
    return { kind: "unadopted", fingerprint: value.fingerprint };
  }
  value = fields(value, ["kind", "revision", "digest"]);
  requireValue(
    value.kind === "disk-box" &&
      Number.isSafeInteger(value.revision) &&
      value.revision > 0 &&
      typeof value.digest === "string" &&
      HASH.test(value.digest),
    "invalid authority token",
  );
  return { kind: "disk-box", revision: value.revision, digest: value.digest };
}
function operation(value) {
  requireValue(
    typeof value === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value),
    "invalid operation ID",
  );
  return value;
}
function transact(db, stores, mode, body) {
  return new Promise((resolve, reject) => {
    let tx, result, failure;
    try {
      tx = db.transaction(stores, mode);
      const guard =
        (callback) =>
        (...args) => {
          try {
            callback(...args);
          } catch (error) {
            failure = error;
            try {
              tx.abort();
            } catch {}
          }
        };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          failure ?? tx.error ?? new Error("Disk box transaction aborted."),
        );
      body(
        tx,
        (value) => {
          result = value;
        },
        guard,
      );
    } catch (error) {
      if (tx) {
        failure = error;
        try {
          tx.abort();
        } catch {
          reject(error);
        }
      } else reject(error);
    }
  });
}
function collect(tx, names, keysOnly, done, guard) {
  const result = {};
  if (!names.length) {
    done(result);
    return;
  }
  let pending = names.length;
  for (const name of names) {
    const request = keysOnly.has(name)
      ? tx.objectStore(name).getAllKeys()
      : tx.objectStore(name).getAll();
    request.onsuccess = guard(() => {
      result[name] = request.result;
      if (--pending === 0) done(result);
    });
  }
}

/** Version-five authority. lease.isOwner() must synchronously reflect the held
 * exclusive writer lease. This store never obtains ownership on a caller's behalf.
 * No garbage collection runs here: all historical rows, ejected disks and backups
 * remain recoverable. Metadata load does not fetch personal image payloads.
 */
export async function openDiskBoxStore({
  indexedDB = globalThis.indexedDB,
  name = "triptych-cpu",
  crypto = globalThis.crypto,
  lease,
  legacyBootstrap,
  onBlocked = () => {},
} = {}) {
  requireValue(
    indexedDB && crypto?.subtle,
    "storage or cryptography unavailable",
  );
  const owned = () => lease?.isOwner?.() === true;
  const assertOwner = () => requireValue(owned(), "writer lease required");
  const writer = owned();
  const db = await new Promise((resolve, reject) => {
    if (writer) assertOwner();
    const opening = writer ? indexedDB.open(name, 5) : indexedDB.open(name);
    let failure;
    opening.onblocked = () =>
      onBlocked("Close older Triptych tabs to upgrade disk-box storage.");
    opening.onerror = () => reject(failure ?? opening.error);
    opening.onupgradeneeded = () => {
      try {
        requireValue(writer, "reader cannot create a database");
        assertOwner();
        for (const [store, keyPath] of [
          [STATE, "key"],
          [BLOBS, "sha256"],
        ])
          if (!opening.result.objectStoreNames.contains(store))
            opening.result.createObjectStore(store, { keyPath });
      } catch (error) {
        failure = error;
        opening.transaction.abort();
      }
    };
    opening.onsuccess = () => {
      const database = opening.result;
      database.onversionchange = () => database.close();
      if (writer && !owned()) {
        database.close();
        reject(new Error("Disk box store: writer lease lost during open."));
      } else resolve(database);
    };
  });
  const history = HISTORY.filter((store) =>
    db.objectStoreNames.contains(store),
  );
  const hasState = db.objectStoreNames.contains(STATE),
    hasBlobs = db.objectStoreNames.contains(BLOBS);
  const localStores = [STATE, BLOBS].filter((store) =>
    db.objectStoreNames.contains(store),
  );
  const historical = createSavedMachineReader(db, { crypto, legacyBootstrap });
  const hashBytes = async (bytes) =>
    Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  const hashJson = (value) => hashBytes(encoder.encode(JSON.stringify(value)));
  // Tag every node so historical objects cannot mimic the byte hash encoding.
  async function fingerprint(value) {
    async function tree(item) {
      if (item instanceof Uint8Array)
        return ["u8", item.length, await hashBytes(item)];
      if (item instanceof ArrayBuffer)
        return ["buffer", item.byteLength, await hashBytes(item)];
      if (Array.isArray(item))
        return ["array", await Promise.all(item.map(tree))];
      if (item && typeof item === "object")
        return [
          "object",
          await Promise.all(
            Object.keys(item)
              .sort()
              .map(async (key) => [key, await tree(item[key])]),
          ),
        ];
      return [typeof item, item];
    }
    return hashJson(await tree(value));
  }
  const readRows = (names, keysOnly = new Set()) =>
    names.length
      ? transact(db, names, "readonly", (tx, done, guard) =>
          collect(tx, names, keysOnly, done, guard),
        )
      : Promise.resolve({});
  const meta = () => readRows(localStores, new Set([BLOBS]));
  async function envelope(raw, expectedKey) {
    fields(raw, ["key", "revision", "operationId", "digest", "manifest"]);
    requireValue(raw.key === expectedKey, "wrong envelope key");
    operation(raw.operationId);
    const authority = token({
      kind: "disk-box",
      revision: raw.revision,
      digest: raw.digest,
    });
    const manifest = validateDiskBoxManifest(raw.manifest);
    requireValue(
      same(manifest, raw.manifest) && (await hashJson(manifest)) === raw.digest,
      "manifest digest mismatch",
    );
    return { ...raw, manifest, token: authority };
  }
  async function inspect(raw) {
    requireValue(hasState === hasBlobs, "incomplete library stores");
    const rows = raw[STATE] ?? [],
      keys = raw[BLOBS] ?? [];
    if (!rows.length && !keys.length) return null;
    requireValue(
      same(
        rows.find((row) => row.key === "activation"),
        MARKER,
      ),
      "missing or invalid activation marker",
    );
    const head = await envelope(
      rows.find((row) => row.key === "head"),
      "head",
    );
    const backups = [],
      operations = new Map();
    for (const row of rows) {
      if (row.key === "activation" || row.key === "head") continue;
      if (typeof row.key === "string" && row.key.startsWith("backup:")) {
        operation(row.key.slice(7));
        backups.push(await envelope(row, row.key));
      } else {
        fields(row, ["key", "expected", "mode", "digest", "receipt"]);
        requireValue(
          typeof row.key === "string" && row.key.startsWith("operation:"),
          "unexplained authority row",
        );
        const id = operation(row.key.slice(10));
        token(row.expected);
        fields(row.receipt, ["revision", "digest", "operationId"]);
        const receiptToken = token({
          kind: "disk-box",
          revision: row.receipt.revision,
          digest: row.receipt.digest,
        });
        requireValue(
          ["checkpoint", "change"].includes(row.mode) &&
            row.digest === row.receipt.digest &&
            row.receipt.operationId === id &&
            receiptToken.revision <= head.revision &&
            receiptToken.revision ===
              (row.expected.kind === "unadopted"
                ? 1
                : row.expected.revision + 1),
          "invalid operation receipt",
        );
        operations.set(id, row);
      }
    }
    const owner = operations.get(head.operationId);
    requireValue(
      owner &&
        same(owner.receipt, {
          revision: head.revision,
          digest: head.digest,
          operationId: head.operationId,
        }),
      "head receipt missing or inconsistent",
    );
    // Receipts are retained for every publication. They form one contiguous
    // chain, not unrelated claims that happen to mention a plausible revision.
    const ordered = [...operations.values()].sort(
      (a, b) => a.receipt.revision - b.receipt.revision,
    );
    requireValue(ordered.length === head.revision, "incomplete receipt chain");
    const backupMap = new Map(backups.map((backup) => [backup.key, backup]));
    for (const [index, row] of ordered.entries()) {
      requireValue(
        row.receipt.revision === index + 1,
        "duplicate or missing receipt revision",
      );
      if (index === 0)
        requireValue(
          row.expected.kind === "unadopted",
          "invalid adoption receipt",
        );
      else
        requireValue(
          same(row.expected, {
            kind: "disk-box",
            revision: index,
            digest: ordered[index - 1].digest,
          }),
          "receipt predecessor mismatch",
        );
      const backupKey = `backup:${row.receipt.operationId}`,
        backup = backupMap.get(backupKey);
      if (index > 0 && row.mode === "change") {
        requireValue(
          backup &&
            backup.revision === index &&
            backup.digest === row.expected.digest &&
            backup.operationId === ordered[index - 1].receipt.operationId,
          "preceding backup missing or inconsistent",
        );
        backupMap.delete(backupKey);
      } else requireValue(!backup, "unexpected checkpoint backup");
    }
    requireValue(backupMap.size === 0, "orphan backup");
    const available = new Set(keys);
    requireValue(
      keys.every((key) => typeof key === "string" && HASH.test(key)),
      "invalid blob key",
    );
    for (const saved of [head, ...backups])
      for (const key of diskBoxReferences(saved.manifest).keys())
        requireValue(available.has(key), "missing personal content");
    return { head, backups, operations };
  }
  async function current() {
    const raw = await meta(),
      active = await inspect(raw);
    if (active)
      return {
        kind: "ready",
        manifest: active.head.manifest,
        token: active.head.token,
        raw,
        active,
      };
    const before = await readRows(history);
    const old = await historical.load();
    requireValue(
      old.kind !== "recovery",
      old.error ?? "historical recovery required",
    );
    const after = await readRows(history);
    requireValue(
      same(before, after),
      "historical authority changed during validation",
    );
    return {
      kind: "unadopted",
      historical: old,
      token: { kind: "unadopted", fingerprint: await fingerprint(before) },
      raw,
      historicalRows: before,
    };
  }
  async function verifiedBlobs(references) {
    if (!references.size) return new Map();
    requireValue(hasBlobs, "missing library blob store");
    const rows = await transact(db, BLOBS, "readonly", (tx, done, guard) => {
      const result = new Map();
      let pending = references.size;
      for (const key of references.keys()) {
        const request = tx.objectStore(BLOBS).get(key);
        request.onsuccess = guard(() => {
          result.set(key, request.result);
          if (--pending === 0) done(result);
        });
      }
    });
    for (const [key, row] of rows)
      if (row !== undefined) {
        fields(row, ["sha256", "bytes"]);
        requireValue(
          row.sha256 === key &&
            row.bytes instanceof Uint8Array &&
            row.bytes.length === references.get(key) &&
            (await hashBytes(row.bytes)) === key,
          "personal content hash mismatch",
        );
      }
    return rows;
  }
  async function publish(expected, operationId, manifest, newBlobs, mode) {
    assertOwner();
    requireValue(
      writer && hasState && hasBlobs,
      "writer must reopen upgraded storage",
    );
    const expectedToken = token(expected),
      id = operation(operationId);
    const prepared = await prepareDiskBox(manifest, newBlobs, crypto);
    assertOwner();
    const before = await current();
    const references = diskBoxReferences(prepared.manifest);
    if (before.active)
      for (const saved of [before.active.head, ...before.active.backups])
        for (const [key, length] of diskBoxReferences(saved.manifest)) {
          requireValue(
            !references.has(key) || references.get(key) === length,
            "conflicting image lengths",
          );
          references.set(key, length);
        }
    const existing = await verifiedBlobs(references),
      incoming = new Map(prepared.blobs.map((blob) => [blob.sha256, blob]));
    for (const key of references.keys())
      requireValue(
        existing.get(key) !== undefined || incoming.has(key),
        "missing personal content",
      );
    assertOwner();
    const transactionStores = [
      ...localStores,
      ...(before.kind === "unadopted" ? history : []),
    ];
    return transact(db, transactionStores, "readwrite", (tx, done, guard) => {
      assertOwner();
      collect(
        tx,
        transactionStores,
        new Set([BLOBS]),
        (actual) => {
          requireValue(
            same(
              Object.fromEntries(
                localStores.map((store) => [store, actual[store]]),
              ),
              before.raw,
            ),
            "stale library authority",
          );
          if (before.kind === "unadopted")
            requireValue(
              same(
                Object.fromEntries(
                  history.map((store) => [store, actual[store]]),
                ),
                before.historicalRows,
              ),
              "stale historical authority",
            );
          const checked = () => {
            assertOwner();
            const prior = before.active?.operations.get(id);
            if (prior) {
              requireValue(
                same(prior.expected, expectedToken) &&
                  prior.digest === prepared.digest &&
                  prior.mode === mode,
                "operation ID reused with different input",
              );
              done({
                status:
                  prior.receipt.revision === before.token.revision
                    ? "committed"
                    : "superseded",
                token: before.token,
                receipt: prior.receipt,
              });
              return;
            }
            requireValue(
              same(expectedToken, before.token),
              "stale revision; reload",
            );
            const revision =
              before.kind === "ready" ? before.token.revision + 1 : 1;
            requireValue(Number.isSafeInteger(revision), "revision exhausted");
            const receipt = {
              revision,
              digest: prepared.digest,
              operationId: id,
            };
            const state = tx.objectStore(STATE);
            for (const [key, blob] of incoming)
              if (existing.get(key) === undefined)
                tx.objectStore(BLOBS).add(blob);
            if (before.kind === "unadopted") state.add(MARKER);
            else if (mode === "change") {
              const { token: ignored, ...backup } = before.active.head;
              state.add({ ...backup, key: `backup:${id}` });
            }
            state.add({
              key: `operation:${id}`,
              expected: expectedToken,
              mode,
              digest: prepared.digest,
              receipt,
            });
            state.put({ key: "head", ...receipt, manifest: prepared.manifest });
            done({
              status: "committed",
              token: { kind: "disk-box", revision, digest: prepared.digest },
              receipt,
            });
          };
          if (!existing.size) {
            checked();
            return;
          }
          let pending = existing.size;
          for (const [key, row] of existing) {
            const request = tx.objectStore(BLOBS).get(key);
            request.onsuccess = guard(() => {
              requireValue(
                same(request.result, row),
                "personal content changed during publication",
              );
              if (--pending === 0) checked();
            });
          }
        },
        guard,
      );
    });
  }
  return {
    async load() {
      try {
        const value = await current();
        return value.kind === "ready"
          ? { kind: "ready", manifest: value.manifest, token: value.token }
          : {
              kind: "unadopted",
              historical: value.historical,
              token: value.token,
            };
      } catch (error) {
        return { kind: "recovery", error: String(error?.message ?? error) };
      }
    },
    async readPersonalDisk(id) {
      const before = await current();
      requireValue(before.kind === "ready", "library not active");
      const disk = before.manifest.personalDisks.find((disk) => disk.id === id);
      requireValue(disk, "unknown personal disk");
      const rows = await verifiedBlobs(
        new Map([[disk.content.sha256, disk.content.byteLength]]),
      );
      requireValue(
        same(await meta(), before.raw),
        "library changed during disk read",
      );
      const row = rows.get(disk.content.sha256);
      requireValue(row, "missing personal content");
      return row.bytes.slice();
    },
    saveCheckpoint: (expected, id, manifest, blobs = new Map()) =>
      publish(expected, id, manifest, blobs, "checkpoint"),
    commitChange: (expected, id, manifest, blobs = new Map()) =>
      publish(expected, id, manifest, blobs, "change"),
    async listBackups() {
      const raw = await meta(),
        result = [];
      for (const row of raw[STATE] ?? [])
        if (typeof row.key === "string" && row.key.startsWith("backup:")) {
          const id = `disk-box:${row.key.slice(7)}`;
          try {
            const value = await envelope(row, row.key);
            result.push({
              id,
              kind: "available",
              revision: value.revision,
              operationId: row.key.slice(7),
            });
          } catch (error) {
            result.push({ id, kind: "recovery", error: String(error.message) });
          }
        }
      return [...result, ...(await historical.listBackups())];
    },
    async readBackup(id) {
      if (!id.startsWith("disk-box:")) return historical.readBackup(id);
      const raw = await meta(),
        row = raw[STATE]?.find((row) => row.key === `backup:${id.slice(9)}`);
      if (!row) return undefined;
      return (await envelope(row, row.key)).manifest;
    },
    readRawRecords(store) {
      if (HISTORY.includes(store)) return historical.readRawRecords(store);
      requireValue([STATE, BLOBS].includes(store), "unknown recovery store");
      return localStores.includes(store)
        ? readRows([store]).then((rows) => rows[store])
        : Promise.resolve([]);
    },
    readRawRecovery(store, key) {
      if (HISTORY.includes(store))
        return historical.readRawRecovery(store, key);
      requireValue([STATE, BLOBS].includes(store), "unknown recovery store");
      if (!localStores.includes(store)) return Promise.resolve(undefined);
      return transact(db, store, "readonly", (tx, done, guard) => {
        const request = tx.objectStore(store).get(key);
        request.onsuccess = guard(() => done(request.result));
      });
    },
    historical,
    close: () => db.close(),
  };
}
