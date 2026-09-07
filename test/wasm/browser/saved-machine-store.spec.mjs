import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

const pageErrors = new WeakMap();
test.afterEach(async ({ page }) => {
  expect(pageErrors.get(page)).toEqual([]);
});

test.beforeEach(async ({ page }) => {
  const errors = [];
  pageErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/saved-machine-store-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Disposable saved machine storage</title>",
    }),
  );
  for (const filename of [
    "saved-machine-store.js",
    "saved-machine.js",
    "drive-set-v4.js",
    "drive-set.js",
    "drive-set-store.js",
    "working-disk-store.js",
  ]) {
    const body = await readFile(
      new URL(
        `../../../crates/triptych-host-wasm/web/${filename}`,
        import.meta.url,
      ),
      "utf8",
    );
    await page.route(`**/${filename}`, (route) =>
      route.fulfill({ contentType: "text/javascript", body }),
    );
  }
  await page.goto("/saved-machine-store-test");
  await page.evaluate(async () => {
    window.openNew = (
      await import("/saved-machine-store.js")
    ).openSavedMachineStore;
    window.openOld = (await import("/drive-set-store.js")).openDriveSetStore;
    window.prepare = (await import("/saved-machine.js")).prepareSavedMachine;
    window.dbName = `saved-machine-${crypto.randomUUID()}`;
    window.boot = new Uint8Array(256).fill(42);
    window.STATE = "drive-set-state-v4";
    window.BLOBS = "drive-set-blobs-v4";
    window.small = (byte) => ({
      bootstrap: { profile: "legacy-e400", bytes: boot },
      drives: {
        A: { name: `${byte}.img`, bytes: new Uint8Array(512).fill(byte) },
        B: null,
      },
    });
    window.machine = (byte, count = 2, sparse = false, same = false) => ({
      schema: "triptych-drive-set-v4",
      configuredCount: count,
      bootstrap: {
        profile: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
        bytes: boot.slice(),
      },
      slots: Array.from({ length: count }, (_, i) =>
        sparse && i !== 0 && i !== count - 1
          ? null
          : {
              instanceId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
              name: `${i}.img`,
              bytes: new Uint8Array(2097152).fill(same ? byte : byte + i),
            },
      ),
    });
    window.open = (options) =>
      openNew({ name: dbName, legacyBootstrap: boot, ...options });
    window.same = (a, b) => {
      if (a === b) return true;
      if (a instanceof Uint8Array || b instanceof Uint8Array)
        return (
          a instanceof Uint8Array &&
          b instanceof Uint8Array &&
          a.length === b.length &&
          a.every((v, i) => v === b[i])
        );
      if (!a || !b || typeof a !== "object" || typeof b !== "object")
        return false;
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length &&
        keys.every((k) => Object.hasOwn(b, k) && same(a[k], b[k]))
      );
    };
    window.rawTx = async (stores, mode, action) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(dbName);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(stores ?? [...db.objectStoreNames], mode);
          const result = action(tx);
          tx.oncomplete = () =>
            resolve(typeof result === "function" ? result() : result);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    window.putRaw = (store, value) =>
      rawTx(store, "readwrite", (tx) => {
        tx.objectStore(store).put(value);
      });
    window.deleteRaw = (store, key) =>
      rawTx(store, "readwrite", (tx) => {
        tx.objectStore(store).delete(key);
      });
    // One transaction captures all rows together; large bytes never leave page.evaluate.
    window.allRaw = () =>
      rawTx(null, "readonly", (tx) => {
        const result = {};
        for (const name of tx.objectStoreNames) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            result[name] = request.result;
          };
        }
        return () => result;
      });
    window.seed = async (version = 2) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open(dbName, version);
        r.onupgradeneeded = () => {
          r.result.createObjectStore("working-disks", { keyPath: "key" });
          if (version >= 2)
            r.result.createObjectStore("disk-revisions", { keyPath: "key" });
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction([...db.objectStoreNames], "readwrite");
        tx.objectStore("working-disks").put({
          key: "drive-a",
          schema: "triptych-working-disk-v1",
          name: "v1.img",
          bytes: new Uint8Array(512).fill(7),
        });
        if (version >= 2)
          tx.objectStore("disk-revisions").put({
            key: "head",
            schema: "triptych-working-disk-v2",
            name: "v2.img",
            bytes: new Uint8Array(512).fill(8),
            revision: 5,
            operationId: "prior",
          });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      return db;
    };
    window.seedV3 = async (large = false) => {
      const db = await seed(2);
      db.close();
      const store = await openOld({ name: dbName, legacyBootstrap: boot });
      const before = await store.load();
      const value = large
        ? {
            bootstrap: { profile: "triptych-cpu-v0.1-8m-ab", bytes: boot },
            drives: {
              A: { name: "a.img", bytes: new Uint8Array(8388608).fill(9) },
              B: { name: "b.img", bytes: new Uint8Array(8388608).fill(10) },
            },
          }
        : small(9);
      await store.commitChange(before.token, "old-promote", value);
      store.close();
    };
    window.failed = (promise) =>
      promise.then(
        () => false,
        () => true,
      );
  });
});

test("v4 publishes exact envelopes, captures once before yielding and returns explicit token/receipt", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        empty = await store.load(),
        value = machine(1);
      const saving = store.saveCheckpoint(empty.token, value);
      value.slots[0].bytes.fill(99);
      value.slots[0].name = "changed";
      const first = await saving;
      const second = await store.commitChange(first.token, "edit", machine(3));
      store.close();
      const reopened = await open(),
        head = await reopened.load(),
        old = await reopened.readBackup("v4:edit");
      const raw = await allRaw();
      const marker = raw[STATE].find((x) => x.key === "activation"),
        h = raw[STATE].find((x) => x.key === "head"),
        b = raw[STATE].find((x) => x.key === "backup:edit");
      old.slots[0].bytes[0] = 88;
      const backupAgain = await reopened.readBackup("v4:edit");
      const detached = await reopened.readRawRecovery(
        BLOBS,
        h.manifest.slots[0].image.sha256,
      );
      detached.bytes.fill(100);
      const reread = await reopened.load();
      reopened.close();
      return {
        empty,
        resultKeys: Object.keys(first).sort(),
        token: first.token.kind,
        receipt: first.receipt.authority,
        revisions: [first.token.revision, second.token.revision],
        captured: backupAgain.slots[0].bytes[0],
        name: backupAgain.slots[0].name,
        current: head.snapshot.slots[0].bytes[0],
        reread: reread.snapshot.slots[0].bytes[0],
        marker,
        headKeys: Object.keys(h).sort(),
        backupKeys: Object.keys(b).sort(),
      };
    }),
  ).toEqual({
    empty: { kind: "empty", token: { kind: "empty" } },
    resultKeys: ["receipt", "token"],
    token: "v4",
    receipt: "v4",
    revisions: [1, 2],
    captured: 1,
    name: "0.img",
    current: 3,
    reread: 3,
    marker: { key: "activation", schema: "triptych-drive-set-authority-v4" },
    headKeys: ["digest", "key", "manifest", "operationId", "revision"],
    backupKeys: ["digest", "key", "manifest", "operationId", "revision"],
  });
});

for (const version of [1, 2, 3])
  test(`first checkpoint preserves complete v${version} predecessor and every historical store`, async ({
    page,
  }) => {
    expect(
      await page.evaluate(async (version) => {
        if (version === 3) await seedV3(true);
        else {
          const db = await seed(version);
          db.close();
        }
        const baseline = await allRaw();
        const store = await open(),
          before = await store.load();
        const blank = await allRaw();
        const result = await store.saveCheckpoint(
          before.token,
          machine(20, 4, true),
        );
        const backup = await store.readBackup(
            `v4:checkpoint:${result.token.revision}`,
          ),
          after = await allRaw();
        const unchanged = Object.keys(baseline).every((name) =>
          same(baseline[name], after[name]),
        );
        store.close();
        return {
          kind: before.token.kind,
          store: before.token.store,
          emptyNew: blank[STATE].length === 0 && blank[BLOBS].length === 0,
          unchanged,
          backup: same(backup, before.snapshot),
          a: backup.drives.A.bytes[0],
          b: backup.drives.B?.bytes[0] ?? null,
          revision: result.token.revision,
        };
      }, version),
    ).toEqual({
      kind: "historical",
      store:
        version === 1
          ? "working-disks"
          : version === 2
            ? "disk-revisions"
            : "drive-set-state",
      emptyNew: true,
      unchanged: true,
      backup: true,
      a: version === 1 ? 7 : version === 2 ? 8 : 9,
      b: version === 3 ? 10 : null,
      revision: version === 1 ? 2 : version === 2 ? 6 : 7,
    });
  });

test("manual empty-to-one publication remains retryable after a newer checkpoint", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      const expected = { kind: "empty" };
      const original = await store.commitChange(expected, "first", machine(1));
      const latest = await store.saveCheckpoint(original.token, machine(3));
      const repeated = await store.commitChange(expected, "first", machine(1));
      const head = await store.load();
      store.close();
      return {
        original: original.token.revision,
        latest: latest.token.revision,
        retry: same(original, repeated),
        head: head.token.revision,
        byte: head.snapshot.slots[0].bytes[0],
      };
    }),
  ).toEqual({ original: 1, latest: 2, retry: true, head: 2, byte: 3 });
});

for (const damage of [
  "marker-only",
  "head-only",
  "bad-marker",
  "unknown-state",
  "orphan-blob",
  "missing-head-with-receipt",
  "missing-marker-with-receipt",
  "bad-head-digest",
  "bad-head-blob",
])
  test(`authority ${damage} fails closed before recovery or retry can fall back`, async ({
    page,
  }) => {
    expect(
      await page.evaluate(async (damage) => {
        const old = await seed(2);
        old.close();
        const store = await open(),
          initial = await store.load();
        let expected = initial.token;
        if (damage.includes("receipt") || damage.startsWith("bad-head")) {
          await store.commitChange(expected, "retry", machine(1));
        }
        if (damage === "marker-only")
          await putRaw(STATE, {
            key: "activation",
            schema: "triptych-drive-set-authority-v4",
          });
        if (damage === "head-only") await putRaw(STATE, { key: "head" });
        if (damage === "bad-marker")
          await putRaw(STATE, { key: "activation", schema: null });
        if (damage === "unknown-state")
          await putRaw(STATE, { key: "surprise" });
        if (damage === "orphan-blob")
          await putRaw(BLOBS, {
            sha256: "a".repeat(64),
            byteLength: 1,
            bytes: new Uint8Array([9]),
          });
        if (damage === "missing-head-with-receipt")
          await deleteRaw(STATE, "head");
        if (damage === "missing-marker-with-receipt")
          await deleteRaw(STATE, "activation");
        if (damage === "bad-head-digest") {
          const head = await store.readRawRecovery(STATE, "head");
          head.digest = "0".repeat(64);
          await putRaw(STATE, head);
        }
        if (damage === "bad-head-blob") {
          const head = await store.readRawRecovery(STATE, "head");
          const blob = await store.readRawRecovery(
            BLOBS,
            head.manifest.slots[0].image.sha256,
          );
          blob.bytes[0] ^= 1;
          await putRaw(BLOBS, blob);
        }
        const before = await allRaw(),
          loaded = await store.load();
        const rejected = await failed(
          store.commitChange(expected, "retry", machine(1)),
        );
        const checkpointRejected = await failed(
          store.saveCheckpoint({ kind: "empty" }, machine(2)),
        );
        const unchanged = same(before, await allRaw());
        store.close();
        return { loaded: loaded.kind, rejected, checkpointRejected, unchanged };
      }, damage),
    ).toEqual({
      loaded: "recovery",
      rejected: true,
      checkpointRejected: true,
      unchanged: true,
    });
  });

for (const version of [2, 3])
  test(`corrupt v${version} authority never falls through to lower valid data`, async ({
    page,
  }) => {
    expect(
      await page.evaluate(async (version) => {
        if (version === 3) await seedV3();
        else {
          const old = await seed(2);
          old.close();
        }
        await putRaw(version === 3 ? "drive-set-state" : "disk-revisions", {
          key: "head",
          schema: null,
        });
        const store = await open(),
          before = await allRaw(),
          result = await store.load();
        const rejected = await failed(
          store.saveCheckpoint({ kind: "empty" }, machine(1)),
        );
        const unchanged = same(before, await allRaw());
        store.close();
        return { kind: result.kind, rejected, unchanged };
      }, version),
    ).toEqual({ kind: "recovery", rejected: true, unchanged: true });
  });

for (const mutation of ["replace", "delete"])
  test(`v3 ${mutation} blob race with unchanged head rejects inside final CAS`, async ({
    page,
  }) => {
    expect(
      await page.evaluate(async (mutation) => {
        await seedV3();
        const store = await open(),
          initial = await store.load();
        let armed = true;
        const racingCrypto = {
          subtle: {
            digest: async (...args) => {
              const result = await crypto.subtle.digest(...args);
              if (
                armed &&
                new TextDecoder()
                  .decode(args[1])
                  .startsWith('{"store":"drive-set-state"')
              ) {
                armed = false;
                const head = await store.readRawRecovery(
                  "drive-set-state",
                  "head",
                );
                const key = head.manifest.drives.A.image.sha256;
                if (mutation === "delete")
                  await deleteRaw("drive-set-blobs", key);
                else {
                  const raw = await store.readRawRecovery(
                    "drive-set-blobs",
                    key,
                  );
                  raw.bytes[511] ^= 1;
                  await putRaw("drive-set-blobs", raw);
                }
              }
              return result;
            },
          },
        };
        const racing = await open({ crypto: racingCrypto });
        const rejected = await failed(
          racing.saveCheckpoint(initial.token, machine(5)),
        );
        const rows = await allRaw();
        store.close();
        racing.close();
        return {
          rejected,
          armed,
          state: rows[STATE].length,
          blobs: rows[BLOBS].length,
        };
      }, mutation),
    ).toEqual({ rejected: true, armed: false, state: 0, blobs: 0 });
  });

test("two writers race, retry stays bound to original publication, and altered identity/content cannot reuse it", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const a = await open(),
        b = await open();
      const raced = await Promise.allSettled([
        a.saveCheckpoint({ kind: "empty" }, machine(1)),
        b.saveCheckpoint({ kind: "empty" }, machine(3)),
      ]);
      const current = await a.load(),
        expected = current.token,
        candidate = machine(5, 16, true);
      const original = await a.commitChange(expected, "retry", candidate);
      const newer = await a.saveCheckpoint(original.token, machine(9));
      const retry = await b.commitChange(expected, "retry", candidate);
      const rejected = [];
      for (const change of [
        (v) => {
          v.slots[15].bytes[2097151] ^= 1;
        },
        (v) => {
          v.bootstrap.bytes[255] ^= 1;
        },
        (v) => {
          v.slots[0].name = "new";
        },
        (v) => {
          v.slots[15] = null;
        },
        (v) => {
          v.slots[15].instanceId = "550e8400-e29b-41d4-a716-999999999999";
        },
        (v) => {
          v.configuredCount = 15;
          v.slots.pop();
          v.bootstrap.profile = "triptych-cpu-v0.1-2m-n15";
        },
      ]) {
        const value = machine(5, 16, true);
        change(value);
        rejected.push(await failed(a.commitChange(expected, "retry", value)));
      }
      const changedExpected = await failed(
        a.commitChange(newer.token, "retry", candidate),
      );
      const head = await a.load();
      a.close();
      b.close();
      return {
        race: raced.map((x) => x.status).sort(),
        same: same(original, retry),
        rejected,
        changedExpected,
        revision: head.token.revision,
        current: head.snapshot.slots[0].bytes[0],
      };
    }),
  ).toEqual({
    race: ["fulfilled", "rejected"],
    same: true,
    rejected: [true, true, true, true, true, true],
    changedExpected: true,
    revision: 3,
    current: 9,
  });
});

for (const stage of ["blob", "activation", "backup", "operation", "head", "gc"])
  for (const failure of ["abort", "quota"])
    test(`${failure} at ${stage} rolls back every row and allows identical retry`, async ({
      page,
    }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      expect(
        await page.evaluate(
          async ({ stage, failure }) => {
            let store, expected;
            if (stage === "activation") {
              const old = await seed(2);
              old.close();
              store = await open();
              expected = (await store.load()).token;
            } else {
              store = await open();
              expected = (
                await store.saveCheckpoint({ kind: "empty" }, machine(1))
              ).token;
            }
            if (stage === "gc")
              await putRaw(BLOBS, {
                sha256: "f".repeat(64),
                byteLength: 1,
                bytes: new Uint8Array([90]),
              });
            const before = await allRaw();
            const method =
              stage === "head" ? "put" : stage === "gc" ? "delete" : "add";
            const original = IDBObjectStore.prototype[method];
            let triggered = 0;
            IDBObjectStore.prototype[method] = function (...args) {
              const selected =
                stage === "blob"
                  ? this.name === BLOBS
                  : stage === "gc"
                    ? this.name === BLOBS
                    : this.name === STATE &&
                      (stage === "activation"
                        ? args[0]?.key === "activation"
                        : stage === "head"
                          ? args[0]?.key === "head"
                          : args[0]?.key?.startsWith(`${stage}:`));
              const result = original.apply(this, args);
              if (selected && !triggered++) {
                if (failure === "quota")
                  throw new DOMException(
                    "injected quota",
                    "QuotaExceededError",
                  );
                this.transaction.abort();
              }
              return result;
            };
            let rejected;
            try {
              rejected = await failed(
                store.commitChange(expected, "failure", machine(3)),
              );
            } finally {
              IDBObjectStore.prototype[method] = original;
            }
            const unchanged = same(before, await allRaw());
            const retry = await store.commitChange(
              expected,
              "failure",
              machine(3),
            );
            store.close();
            return {
              rejected,
              triggered: triggered > 0,
              unchanged,
              retry: retry.token.revision,
            };
          },
          { stage, failure },
        ),
      ).toEqual({
        rejected: true,
        triggered: true,
        unchanged: true,
        retry: stage === "activation" ? 6 : 2,
      });
      expect(errors).toEqual([]);
    });

test("late request success followed by abort is never acknowledged as publication", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      const first = await store.saveCheckpoint({ kind: "empty" }, machine(1));
      const before = await allRaw();
      const original = IDBObjectStore.prototype.put;
      let triggered = false;
      IDBObjectStore.prototype.put = function (...args) {
        const request = original.apply(this, args);
        if (this.name === STATE && args[0]?.key === "head") {
          const tx = this.transaction;
          request.addEventListener("success", () => {
            triggered = true;
            tx.abort();
          });
        }
        return request;
      };
      let rejected;
      try {
        rejected = await failed(
          store.commitChange(first.token, "late", machine(2)),
        );
      } finally {
        IDBObjectStore.prototype.put = original;
      }
      const unchanged = same(before, await allRaw());
      store.close();
      return { rejected, triggered, unchanged };
    }),
  ).toEqual({ rejected: true, triggered: true, unchanged: true });
});

test("lost operation receipt and checkpoint/manual backup-name collision cannot overwrite backups", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const db = await seed(2);
      db.close();
      const store = await open(),
        old = await store.load();
      const first = await store.saveCheckpoint(old.token, machine(1));
      const collision = await failed(
        store.commitChange(first.token, "checkpoint:6", machine(2)),
      );
      const published = await store.commitChange(
        first.token,
        "lost",
        machine(2),
      );
      await deleteRaw(STATE, "operation:lost");
      const before = await allRaw();
      const failedOld = await failed(
        store.commitChange(first.token, "lost", machine(2)),
      );
      const failedCurrent = await failed(
        store.commitChange(published.token, "lost", machine(2)),
      );
      const unchanged = same(before, await allRaw());
      const prior = await store.readBackup("v4:checkpoint:6");
      store.close();
      return {
        collision,
        failedOld,
        failedCurrent,
        unchanged,
        prior: prior.drives.A.bytes[0],
      };
    }),
  ).toEqual({
    collision: true,
    failedOld: true,
    failedCurrent: true,
    unchanged: true,
    prior: 8,
  });
});

test("async duplicate-key error rolls back blob, marker, backup, operation and head together", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const db = await seed(2);
      db.close();
      const store = await open(),
        expected = (await store.load()).token,
        before = await allRaw();
      const original = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        if (this.name === STATE && args[0]?.key?.startsWith("operation:"))
          original.apply(this, args);
        return original.apply(this, args);
      };
      let rejected;
      try {
        rejected = await failed(
          store.commitChange(expected, "duplicate", machine(1)),
        );
      } finally {
        IDBObjectStore.prototype.add = original;
      }
      const unchanged = same(before, await allRaw());
      store.close();
      return { rejected, unchanged };
    }),
  ).toEqual({ rejected: true, unchanged: true });
});

test("new GC retains v3 and v4 backups, discards receipt-only images and never touches historical stores", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      await seedV3();
      const store = await open(),
        old = await store.load(),
        historical = await allRaw();
      const first = await store.commitChange(
        old.token,
        "legacy",
        machine(1, 2, false, true),
      );
      const original = await store.commitChange(
        first.token,
        "native",
        machine(3),
      );
      const last = await store.saveCheckpoint(original.token, machine(5));
      const retried = await store.commitChange(
        first.token,
        "native",
        machine(3),
      );
      const legacy = await store.readBackup("v4:legacy"),
        native = await store.readBackup("v4:native");
      native.slots[0].bytes[0] = 99;
      const rows = await allRaw(),
        values = rows[BLOBS].filter((x) => x.byteLength === 2097152)
          .map((x) => x.bytes[0])
          .sort();
      const untouched = Object.keys(historical)
        .filter((key) => ![STATE, BLOBS].includes(key))
        .every((key) => same(historical[key], rows[key]));
      store.close();
      return {
        legacy: legacy.drives.A.bytes[0],
        independent: native.slots[1].bytes[0],
        values,
        untouched,
        retry: same(original, retried),
        last: last.token.revision,
      };
    }),
  ).toEqual({
    legacy: 9,
    independent: 1,
    values: [1, 5, 6],
    untouched: true,
    retry: true,
    last: 9,
  });
});

for (const damage of ["wrong-digest", "unknown-manifest", "missing-reference"])
  test(`backup ${damage} suspends GC and remains recoverable without invalidating sound head`, async ({
    page,
  }) => {
    expect(
      await page.evaluate(async (damage) => {
        const store = await open(),
          first = await store.saveCheckpoint({ kind: "empty" }, machine(1));
        const second = await store.commitChange(
          first.token,
          "backup",
          machine(3),
        );
        const root = await store.readRawRecovery(STATE, "backup:backup");
        const retained = root.manifest.slots[0].image.sha256;
        const substitute = await prepare(machine(7));
        if (damage === "unknown-manifest")
          root.manifest = { schema: "future-v99" };
        else {
          root.manifest = substitute.manifest;
          if (damage === "missing-reference") root.digest = substitute.digest;
          else
            for (const blob of substitute.blobs)
              await putRaw(BLOBS, {
                sha256: blob.sha256,
                byteLength: blob.bytes.length,
                bytes: blob.bytes,
              });
        }
        await putRaw(STATE, root);
        await putRaw(BLOBS, {
          sha256: "f".repeat(64),
          byteLength: 1,
          bytes: new Uint8Array([90]),
        });
        const latest = await store.saveCheckpoint(second.token, machine(9));
        const rejected = await failed(store.readBackup("v4:backup")),
          orphan = await store.readRawRecovery(BLOBS, "f".repeat(64)),
          original = await store.readRawRecovery(BLOBS, retained),
          list = await store.listBackups();
        store.close();
        return {
          revision: latest.token.revision,
          rejected,
          orphan: orphan.bytes[0],
          original: original.bytes[0],
          listed: list[0].kind,
        };
      }, damage),
    ).toEqual({
      revision: 3,
      rejected: true,
      orphan: 90,
      original: 1,
      listed: damage === "missing-reference" ? "available" : "recovery",
    });
  });

test("GC rechecks exact backup metadata after asynchronous digest verification", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        first = await store.saveCheckpoint({ kind: "empty" }, machine(1)),
        second = await store.commitChange(first.token, "root", machine(3));
      await putRaw(BLOBS, {
        sha256: "f".repeat(64),
        byteLength: 1,
        bytes: new Uint8Array([90]),
      });
      const root = await store.readRawRecovery(STATE, "backup:root");
      let armed = true;
      const racing = await open({
        crypto: {
          subtle: {
            digest: async (...args) => {
              const result = await crypto.subtle.digest(...args);
              if (
                armed &&
                new TextDecoder().decode(args[1]) ===
                  JSON.stringify(root.manifest)
              ) {
                armed = false;
                const changed = structuredClone(root);
                changed.digest = "0".repeat(64);
                await putRaw(STATE, changed);
              }
              return result;
            },
          },
        },
      });
      const rejected = await failed(
        racing.saveCheckpoint(second.token, machine(5)),
      );
      const orphan = await store.readRawRecovery(BLOBS, "f".repeat(64));
      store.close();
      racing.close();
      return { rejected, armed, orphan: orphan.bytes[0] };
    }),
  ).toEqual({ rejected: true, armed: false, orphan: 90 });
});

test("immutable candidate blob corruption is not overwritten", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        first = await store.saveCheckpoint({ kind: "empty" }, machine(1)),
        candidate = await prepare(machine(3));
      const blob = candidate.blobs.find((x) => x.bytes.length === 2097152);
      await putRaw(BLOBS, {
        sha256: blob.sha256,
        byteLength: blob.bytes.length,
        bytes: new Uint8Array(blob.bytes.length).fill(99),
      });
      const before = await allRaw(),
        rejected = await failed(store.saveCheckpoint(first.token, machine(3))),
        unchanged = same(before, await allRaw());
      store.close();
      return { rejected, unchanged };
    }),
  ).toEqual({ rejected: true, unchanged: true });
});

test("all sixteen media and sparse A/P keep identities and listing reads no image blobs", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        value = machine(1, 16),
        first = await store.saveCheckpoint({ kind: "empty" }, value),
        loaded = await store.load();
      const complete = same(value, loaded.snapshot);
      const sparse = machine(2, 16, true);
      await store.commitChange(first.token, "sparse", sparse);
      const originalGet = IDBObjectStore.prototype.get,
        originalAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.get = function (...args) {
        if (this.name === BLOBS || this.name === "drive-set-blobs")
          throw Error("listing read payload");
        return originalGet.apply(this, args);
      };
      IDBObjectStore.prototype.getAll = function (...args) {
        if (this.name === BLOBS || this.name === "drive-set-blobs")
          throw Error("listing read payload");
        return originalAll.apply(this, args);
      };
      let list;
      try {
        list = await store.listBackups();
      } finally {
        IDBObjectStore.prototype.get = originalGet;
        IDBObjectStore.prototype.getAll = originalAll;
      }
      const reopened = await store.load();
      store.close();
      return {
        complete,
        listed: list.length,
        sparse: same(sparse, reopened.snapshot),
        slots: reopened.snapshot.slots.map((x) => x !== null),
      };
    }),
  ).toEqual({
    complete: true,
    listed: 1,
    sparse: true,
    slots: [
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ],
  });
});

for (const failedStore of ["drive-set-state-v4", "drive-set-blobs-v4"])
  test(`schema failure after ${failedStore} creation restores old database version and data`, async ({
    page,
  }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    expect(
      await page.evaluate(async (failedStore) => {
        const old = await seed(2);
        old.close();
        const before = await allRaw(),
          original = IDBDatabase.prototype.createObjectStore;
        IDBDatabase.prototype.createObjectStore = function (...args) {
          const result = original.apply(this, args);
          if (args[0] === failedStore)
            throw new DOMException("quota", "QuotaExceededError");
          return result;
        };
        let rejected;
        try {
          rejected = await failed(open());
        } finally {
          IDBDatabase.prototype.createObjectStore = original;
        }
        const unchanged = same(before, await allRaw());
        const version = await new Promise((resolve, reject) => {
          const r = indexedDB.open(dbName, 2);
          r.onerror = () => reject(r.error);
          r.onsuccess = () => {
            resolve(r.result.version);
            r.result.close();
          };
        });
        const retry = await open(),
          loaded = await retry.load();
        retry.close();
        return { rejected, unchanged, version, kind: loaded.kind };
      }, failedStore),
    ).toEqual({ rejected: true, unchanged: true, version: 2, kind: "ready" });
    expect(errors).toEqual([]);
  });

test("blocked legacy connection and versionchange closure preserve migration authority", async ({
  page,
}) => {
  await page.evaluate(async () => {
    window.old = await seed(1);
    window.blocked = "";
    window.pending = open({
      onBlocked: (value) => {
        window.blocked = value;
      },
    });
  });

  await expect
    .poll(() => page.evaluate(() => blocked))
    .toContain("Close older Triptych tabs");
  expect(
    await page.evaluate(async () => {
      old.close();
      const store = await pending,
        loaded = await store.load();
      const version = await new Promise((resolve, reject) => {
        const r = indexedDB.open(dbName, 5);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(Error("new store did not close"));
        r.onsuccess = () => {
          resolve(r.result.version);
          r.result.close();
        };
      });
      return { kind: loaded.token.kind, store: loaded.token.store, version };
    }),
  ).toEqual({ kind: "historical", store: "working-disks", version: 5 });
});

for (const damage of [
  "extra-field",
  "missing-field",
  "unknown-authority",
  "extra-receipt-field",
  "unknown-token",
  "extra-token-field",
  "bad-historical-store",
  "bad-identity",
  "bad-revision",
  "wrong-key-binding",
  "wrong-digest-binding",
  "missing-receipt",
  "positive-transition-mismatch",
  "empty-transition-mismatch",
  "safe-integer-overflow",
  "historical-future-receipt",
  "equal-revision-wrong-digest",
  "equal-revision-wrong-operation",
])
  test(`malformed operation ${damage} requires recovery before any publication or retry`, async ({
    page,
  }) => {
    expect(
      await page.evaluate(async (damage) => {
        const store = await open();
        const first = await store.saveCheckpoint({ kind: "empty" }, machine(1));
        const operationRows = (await allRaw())[STATE].filter((row) =>
          row.key.startsWith("operation:"),
        );
        const result = await store.commitChange(
          first.token,
          "retry",
          machine(3),
        );
        const record = await store.readRawRecovery(STATE, "operation:retry");
        if (damage === "extra-field") record.future = true;
        if (damage === "missing-field") delete record.expected;
        if (damage === "unknown-authority") record.receipt.authority = "v5";
        if (damage === "extra-receipt-field") record.receipt.future = true;
        if (damage === "unknown-token") record.expected.kind = "v5";
        if (damage === "extra-token-field") record.expected.future = true;
        if (damage === "bad-historical-store")
          record.expected = {
            kind: "historical",
            store: "unknown",
            identity: "a".repeat(64),
          };
        if (damage === "bad-identity")
          record.expected = {
            kind: "historical",
            store: "working-disks",
            identity: "bad",
          };
        if (damage === "bad-revision") record.receipt.revision = 0;
        if (damage === "wrong-key-binding")
          record.receipt.operationId = "other";
        if (damage === "wrong-digest-binding") record.digest = "0".repeat(64);
        if (damage === "missing-receipt") record.receipt = null;
        if (damage === "positive-transition-mismatch")
          record.receipt.revision = 999;
        if (damage === "empty-transition-mismatch")
          record.expected = { kind: "empty" };
        if (damage === "safe-integer-overflow") {
          record.expected.revision = Number.MAX_SAFE_INTEGER;
          record.receipt.revision = Number.MAX_SAFE_INTEGER;
        }
        if (damage === "historical-future-receipt") {
          record.expected = {
            kind: "historical",
            store: "working-disks",
            identity: "a".repeat(64),
          };
          record.receipt.revision = 999;
        }
        if (damage === "equal-revision-wrong-digest") {
          record.digest = "0".repeat(64);
          record.receipt.digest = record.digest;
        }
        if (damage === "equal-revision-wrong-operation") {
          record.key = "operation:other";
          record.receipt.operationId = "other";
        }
        await putRaw(STATE, record);
        await putRaw(BLOBS, {
          sha256: "f".repeat(64),
          byteLength: 1,
          bytes: new Uint8Array([90]),
        });
        const before = await allRaw();
        const loaded = await store.load();
        const checkpoint = await failed(
          store.saveCheckpoint(result.token, machine(5)),
        );
        const unrelated = await failed(
          store.commitChange(result.token, "unrelated", machine(5)),
        );
        const retry = await failed(
          store.commitChange(first.token, "retry", machine(3)),
        );
        const unchanged = same(before, await allRaw());
        const raw = await store.readRawRecovery(STATE, record.key);
        store.close();
        return {
          checkpointOperationRows: operationRows.length,
          loaded: loaded.kind,
          checkpoint,
          unrelated,
          retry,
          unchanged,
          raw: same(raw, record),
        };
      }, damage),
    ).toEqual({
      checkpointOperationRows: 0,
      loaded: "recovery",
      checkpoint: true,
      unrelated: true,
      retry: true,
      unchanged: true,
      raw: true,
    });
  });
