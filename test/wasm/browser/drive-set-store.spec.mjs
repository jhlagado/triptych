import { expect, test } from "./legacy-fixture.mjs";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.route("**/drive-set-store-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Disposable drive-set storage</title>",
    }),
  );
  for (const filename of [
    "drive-set-store.js",
    "drive-set.js",
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
  await page.goto("/drive-set-store-test");
  await page.evaluate(async () => {
    window.openSet = (await import("/drive-set-store.js")).openDriveSetStore;
    window.prepareSet = (await import("/drive-set.js")).prepareDriveSet;
    window.dbName = `drive-set-${crypto.randomUUID()}`;
    window.boot = new Uint8Array(256).fill(42);
    window.small = (byte) => ({
      bootstrap: { profile: "legacy-e400", bytes: boot },
      drives: {
        A: { name: `${byte}.img`, bytes: new Uint8Array(512).fill(byte) },
        B: null,
      },
    });
    window.large = (a, b) => ({
      bootstrap: { profile: "triptych-cpu-v0.1-8m-ab", bytes: boot },
      drives: {
        A: { name: "a.img", bytes: new Uint8Array(8388608).fill(a) },
        B:
          b === null
            ? null
            : { name: "b.img", bytes: new Uint8Array(8388608).fill(b) },
      },
    });
    window.open = (options = {}) =>
      openSet({ name: dbName, legacyBootstrap: boot, ...options });
    window.rawTransaction = async (stores, mode, action) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(stores, mode);
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
      rawTransaction(store, "readwrite", (tx) => {
        tx.objectStore(store).put(value);
      });
    window.allRaw = (store) =>
      rawTransaction(store, "readonly", (tx) => {
        const get = tx.objectStore(store).getAll();
        return () => get.result;
      });
    window.seed = (version, records) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("working-disks", { keyPath: "key" });
          if (version === 2)
            request.result.createObjectStore("disk-revisions", {
              keyPath: "key",
            });
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction([...db.objectStoreNames], "readwrite");
          for (const [store, value] of records)
            tx.objectStore(store).put(value);
          tx.oncomplete = () => resolve(db);
          tx.onabort = () => reject(tx.error);
        };
      });
    window.oldDisk = (byte, revision = 5) => ({
      schema: "triptych-working-disk-v2",
      key: "head",
      revision,
      operationId: `old-${revision}`,
      name: "old.img",
      bytes: new Uint8Array(512).fill(byte),
    });
  });
});

test("copies before yielding, returns metadata receipts, and restores exact head and backups", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      let store = await open();
      const empty = await store.load();
      const source = small(1);
      const saving = store.saveCheckpoint(empty.token, source);
      source.drives.A.bytes.fill(99);
      const first = await saving;
      const second = await store.commitChange(
        { kind: "v3", revision: 1 },
        "edit",
        small(2),
      );
      store.close();
      store = await open();
      const value = await store.load();
      value.snapshot.drives.A.bytes.fill(88);
      const reread = await store.load(),
        backup = await store.readBackup("v3:edit");
      const list = await store.listBackups();
      store.close();
      return {
        empty,
        keys: Object.keys(first).sort(),
        revisions: [first.revision, second.revision],
        current: reread.snapshot.drives.A.bytes.every((b) => b === 2),
        backup: backup.drives.A.bytes.every((b) => b === 1),
        boot: backup.bootstrap.bytes.every((b) => b === 42),
        list,
      };
    }),
  ).toEqual({
    empty: { kind: "empty", token: { kind: "empty" } },
    keys: ["digest", "operationId", "revision"],
    revisions: [1, 2],
    current: true,
    backup: true,
    boot: true,
    list: [
      { id: "v3:edit", kind: "available", revision: 1, operationId: "edit" },
    ],
  });
});

test("whole-set CAS includes B, bootstrap, presence and names; old retries cannot restore a newer head", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const a = await open(),
        b = await open();
      const empty = { kind: "empty" };
      const races = await Promise.allSettled([
        a.saveCheckpoint(empty, large(1, 2)),
        b.saveCheckpoint(empty, large(3, 4)),
      ]);
      const candidate = large(5, 6),
        expected = { kind: "v3", revision: 1 };
      const receipt = await a.commitChange(expected, "retry", candidate);
      await a.saveCheckpoint({ kind: "v3", revision: 2 }, large(7, 8));
      const retry = await b.commitChange(expected, "retry", candidate);
      const mismatches = [];
      for (const change of [
        (x) => {
          x.drives.B.bytes[500] = 9;
        },
        (x) => {
          x.drives.A.name = "different.img";
        },
        (x) => {
          x.drives.B = null;
        },
        (x) => {
          x.bootstrap.bytes[255] = 9;
        },
      ]) {
        const altered = large(5, 6);
        change(altered);
        mismatches.push(
          await a.commitChange(expected, "retry", altered).then(
            () => false,
            () => true,
          ),
        );
      }
      const stale = await a.saveCheckpoint(expected, large(1, 2)).then(
        () => false,
        () => true,
      );
      const head = await a.load(),
        backups = await a.listBackups();
      a.close();
      b.close();
      return {
        races: races.map((x) => x.status).sort(),
        sameReceipt: JSON.stringify(receipt) === JSON.stringify(retry),
        mismatches,
        stale,
        revision: head.token.revision,
        pair: [
          head.snapshot.drives.A.bytes[0],
          head.snapshot.drives.B.bytes[0],
        ],
        backups: backups.length,
      };
    }),
  ).toEqual({
    races: ["fulfilled", "rejected"],
    sameReceipt: true,
    mismatches: [true, true, true, true],
    stale: true,
    revision: 3,
    pair: [7, 8],
    backups: 1,
  });
});

for (const stage of ["blob", "backup", "head", "gc"]) {
  for (const failure of ["abort", "quota"]) {
    test(`${failure} at ${stage} rolls back every store and permits identical retry`, async ({
      page,
    }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      expect(
        await page.evaluate(
          async ({ stage, failure }) => {
            const store = await open();
            await store.saveCheckpoint({ kind: "empty" }, small(1));
            // An unreferenced blob makes the cleanup deletion branch observable.
            await putRaw("drive-set-blobs", {
              sha256: "f".repeat(64),
              byteLength: 1,
              bytes: new Uint8Array([90]),
            });
            const before = {
              state: await allRaw("drive-set-state"),
              blobs: await allRaw("drive-set-blobs"),
            };
            const method =
              stage === "head" ? "put" : stage === "gc" ? "delete" : "add";
            const original = IDBObjectStore.prototype[method];
            let triggered = 0;
            IDBObjectStore.prototype[method] = function (...args) {
              const selected =
                stage === "blob"
                  ? this.name === "drive-set-blobs"
                  : stage === "backup"
                    ? this.name === "drive-set-state" &&
                      args[0]?.key?.startsWith("backup:")
                    : stage === "head"
                      ? this.name === "drive-set-state" &&
                        args[0]?.key === "head"
                      : this.name === "drive-set-blobs";
              const result = original.apply(this, args);
              if (selected && !triggered++) {
                if (failure === "quota")
                  throw new DOMException(
                    "Injected quota failure",
                    "QuotaExceededError",
                  );
                this.transaction.abort();
              }
              return result;
            };
            let rejected;
            try {
              await store.commitChange(
                { kind: "v3", revision: 1 },
                "failure",
                small(2),
              );
              rejected = false;
            } catch {
              rejected = true;
            } finally {
              IDBObjectStore.prototype[method] = original;
            }
            const after = {
              state: await allRaw("drive-set-state"),
              blobs: await allRaw("drive-set-blobs"),
            };
            const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
            const retry = await store.commitChange(
              { kind: "v3", revision: 1 },
              "failure",
              small(2),
            );
            store.close();
            return {
              rejected,
              triggered: triggered > 0,
              unchanged: same(before, after),
              retry: retry.revision,
            };
          },
          { stage, failure },
        ),
      ).toEqual({ rejected: true, triggered: true, unchanged: true, retry: 2 });
      expect(errors).toEqual([]);
    });
  }
}

test("lost receipts cannot roll back a newer head or overwrite the retained backup", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      await store.saveCheckpoint({ kind: "empty" }, small(1));
      await store.commitChange({ kind: "v3", revision: 1 }, "lost", small(2));
      await rawTransaction("drive-set-state", "readwrite", (tx) => {
        tx.objectStore("drive-set-state").delete("operation:lost");
      });
      await store.saveCheckpoint({ kind: "v3", revision: 2 }, small(3));
      const snapshot = async () =>
        JSON.stringify({
          state: await allRaw("drive-set-state"),
          blobs: await allRaw("drive-set-blobs"),
        });
      const before = await snapshot();
      const attempts = [];
      for (const revision of [1, 3]) {
        const rejected = await store
          .commitChange({ kind: "v3", revision }, "lost", small(2))
          .then(
            () => false,
            () => true,
          );
        attempts.push({ rejected, exact: (await snapshot()) === before });
      }
      const head = await store.load();
      const prior = await store.readBackup("v3:lost");
      store.close();
      return {
        attempts,
        current: head.snapshot.drives.A.bytes[0],
        prior: prior.drives.A.bytes[0],
      };
    }),
  ).toEqual({
    attempts: [
      { rejected: true, exact: true },
      { rejected: true, exact: true },
    ],
    current: 3,
    prior: 1,
  });
});

test("asynchronous duplicate-key failure rolls back candidate blobs, head, backup and receipt", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      await store.saveCheckpoint({ kind: "empty" }, small(1));
      const before = await allRaw("drive-set-blobs");
      const original = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.add = function (...args) {
        if (
          this.name === "drive-set-state" &&
          args[0].key.startsWith("operation:")
        )
          original.apply(this, args);
        return original.apply(this, args);
      };
      let failed;
      try {
        await store.commitChange(
          { kind: "v3", revision: 1 },
          "duplicate",
          small(2),
        );
        failed = false;
      } catch {
        failed = true;
      } finally {
        IDBObjectStore.prototype.add = original;
      }
      const after = await allRaw("drive-set-blobs"),
        head = await store.load(),
        list = await store.listBackups();
      store.close();
      return {
        failed,
        unchanged: JSON.stringify(before) === JSON.stringify(after),
        revision: head.token.revision,
        backups: list.length,
      };
    }),
  ).toEqual({ failed: true, unchanged: true, revision: 1, backups: 0 });
});

test("shared image blobs survive backups, while unreferenced checkpoint blobs and receipt-only images are collected", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      await store.saveCheckpoint({ kind: "empty" }, large(1, 1));
      const initial = (await allRaw("drive-set-blobs")).length;
      const expected = { kind: "v3", revision: 1 },
        candidate = large(1, 2);
      const original = await store.commitChange(expected, "shared", candidate);
      const changed = (await allRaw("drive-set-blobs")).length;
      await store.saveCheckpoint({ kind: "v3", revision: 2 }, large(1, 3));
      const rows = await allRaw("drive-set-blobs");
      const retry = await store.commitChange(expected, "shared", candidate);
      const old = await store.readBackup("v3:shared");
      old.drives.A.bytes[0] = 90;
      const independent = old.drives.B.bytes[0] === 1;
      const head = await store.load();
      store.close();
      return {
        initial,
        changed,
        remaining: rows.length,
        largeValues: rows
          .filter((x) => x.byteLength === 8388608)
          .map((x) => x.bytes[0])
          .sort(),
        retry: JSON.stringify(original) === JSON.stringify(retry),
        independent,
        currentB: head.snapshot.drives.B.bytes[0],
      };
    }),
  ).toEqual({
    initial: 2,
    changed: 3,
    remaining: 3,
    largeValues: [1, 3],
    retry: true,
    independent: true,
    currentB: 3,
  });
});

test("malformed backup roots suspend cleanup and remain visible beside valid backups", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      await store.saveCheckpoint({ kind: "empty" }, small(1));
      await store.commitChange({ kind: "v3", revision: 1 }, "valid", small(2));
      await putRaw("drive-set-state", {
        key: "backup:broken",
        operationId: "broken",
        revision: 1,
        manifest: { bad: true },
      });
      const orphan = {
        sha256: "f".repeat(64),
        byteLength: 1,
        bytes: new Uint8Array([90]),
      };
      await putRaw("drive-set-blobs", orphan);
      await store.saveCheckpoint({ kind: "v3", revision: 2 }, small(3));
      const list = await store.listBackups(),
        raw = await store.readRawRecovery("drive-set-blobs", orphan.sha256);
      const preserved = await store.readBackup("v3:valid");
      store.close();
      return {
        kinds: list.map((x) => [x.id, x.kind]),
        orphan: [...raw.bytes],
        backup: preserved.drives.A.bytes[0],
      };
    }),
  ).toEqual({
    kinds: [
      ["v3:broken", "recovery"],
      ["v3:valid", "available"],
    ],
    orphan: [90],
    backup: 1,
  });
});

test("existing wrong bytes at a candidate hash reject rather than overwrite immutable storage", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      await store.saveCheckpoint({ kind: "empty" }, small(1));
      const candidate = await prepareSet(small(2));
      const image = candidate.blobs.find((x) => x.bytes.length === 512);
      await putRaw("drive-set-blobs", {
        sha256: image.sha256,
        byteLength: 512,
        bytes: new Uint8Array(512).fill(77),
      });
      const failure = await store
        .saveCheckpoint({ kind: "v3", revision: 1 }, small(2))
        .then(
          () => "accepted",
          (e) => e.message,
        );
      const head = await store.load(),
        raw = await store.readRawRecovery("drive-set-blobs", image.sha256);
      store.close();
      return {
        failure,
        revision: head.token.revision,
        retained: raw.bytes.every((b) => b === 77),
      };
    }),
  ).toEqual({
    failure: "Immutable drive-set blob collision or corruption.",
    revision: 1,
    retained: true,
  });
});

test("missing backup references suspend collection rather than guess which blobs are recoverable", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      await store.saveCheckpoint({ kind: "empty" }, small(1));
      const missing = await prepareSet(small(4));
      await putRaw("drive-set-state", {
        key: "backup:missing",
        operationId: "missing",
        revision: 1,
        manifest: missing.manifest,
      });
      await putRaw("drive-set-blobs", {
        sha256: "f".repeat(64),
        byteLength: 1,
        bytes: new Uint8Array([90]),
      });
      await store.saveCheckpoint({ kind: "v3", revision: 1 }, small(2));
      const orphan = await store.readRawRecovery(
        "drive-set-blobs",
        "f".repeat(64),
      );
      const failed = await store.readBackup("v3:missing").then(
        () => false,
        () => true,
      );
      store.close();
      return { retained: orphan.bytes[0], failed };
    }),
  ).toEqual({ retained: 90, failed: true });
});

test("schema creation failure rolls back the version upgrade and preserves legacy bytes for retry", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  expect(
    await page.evaluate(async () => {
      const old = await seed(2, [["disk-revisions", oldDisk(7)]]);
      old.close();
      const original = IDBDatabase.prototype.createObjectStore;
      IDBDatabase.prototype.createObjectStore = function (...args) {
        const result = original.apply(this, args);
        if (args[0] === "drive-set-state")
          throw new DOMException(
            "Injected upgrade quota",
            "QuotaExceededError",
          );
        return result;
      };
      let failure;
      try {
        await open();
        failure = "accepted";
      } catch (error) {
        failure = error.name;
      } finally {
        IDBDatabase.prototype.createObjectStore = original;
      }
      const check = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("disk-revisions", "readonly");
          const get = tx.objectStore("disk-revisions").get("head");
          tx.oncomplete = () => {
            resolve({
              version: db.version,
              stores: [...db.objectStoreNames],
              bytes: get.result.bytes.every((b) => b === 7),
            });
            db.close();
          };
          tx.onabort = () => reject(tx.error);
        };
      });
      const retry = await open(),
        value = await retry.load();
      retry.close();
      return { failure, check, retry: value.kind };
    }),
  ).toEqual({
    failure: "QuotaExceededError",
    check: {
      version: 2,
      stores: ["disk-revisions", "working-disks"],
      bytes: true,
    },
    retry: "ready",
  });
  expect(errors).toEqual([]);
});

test("legacy v2 authority and backups remain exact; first publication creates a complete legacy backup", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const prior = {
        name: "prior.img",
        bytes: new Uint8Array(512).fill(3),
        revision: 4,
        operationId: "prior",
      };
      const old = await seed(2, [
        [
          "working-disks",
          {
            schema: "triptych-working-disk-v1",
            key: "drive-a",
            name: "stale.img",
            bytes: new Uint8Array(512).fill(99),
          },
        ],
        ["disk-revisions", oldDisk(7)],
        [
          "disk-revisions",
          { key: "change:old", before: prior, after: oldDisk(7) },
        ],
        ["disk-revisions", { key: "change:broken", before: { bytes: [1] } }],
      ]);
      old.close();
      const store = await open(),
        first = await store.load();
      const baseline = await allRaw("disk-revisions");
      const published = await store.commitChange(
        first.token,
        "promote",
        small(8),
      );
      const preserved = await store.readBackup("v3:promote"),
        oldBackup = await store.readBackup("v2:old");
      const list = await store.listBackups();
      const exact =
        JSON.stringify(baseline) ===
        JSON.stringify(await allRaw("disk-revisions"));
      const stale = await store.saveCheckpoint(first.token, small(9)).then(
        () => false,
        () => true,
      );
      store.close();
      return {
        token: first.token.kind,
        a: first.snapshot.drives.A.bytes[0],
        profile: first.snapshot.bootstrap.profile,
        revision: published.revision,
        preserved: preserved.drives.A.bytes[0],
        oldBackup: oldBackup.drives.A.bytes[0],
        exact,
        stale,
        entries: list.map((x) => [x.id, x.kind]).sort(),
      };
    }),
  ).toEqual({
    token: "legacy",
    a: 7,
    profile: "legacy-e400",
    revision: 6,
    preserved: 7,
    oldBackup: 3,
    exact: true,
    stale: true,
    entries: [
      ["v2:broken", "recovery"],
      ["v2:old", "available"],
      ["v3:promote", "available"],
    ],
  });
});

test("legacy tokens distinguish metadata-only replacement, including a race during asynchronous hashing", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const db = await seed(2, [["disk-revisions", oldDisk(7)]]);
      db.close();
      const store = await open(),
        first = await store.load();
      const changed = { ...oldDisk(7), operationId: "replaced-same-bytes" };
      await putRaw("disk-revisions", changed);
      const second = await store.load();
      const stale = await store.saveCheckpoint(first.token, small(8)).then(
        () => false,
        () => true,
      );
      let armed = true;
      const racingCrypto = {
        subtle: {
          digest: async (...args) => {
            const result = await crypto.subtle.digest(...args);
            // Legacy identity is the final hash before the write transaction.
            if (
              armed &&
              new TextDecoder().decode(args[1]).startsWith('{"store":')
            ) {
              armed = false;
              await putRaw("disk-revisions", { ...changed, revision: 6 });
            }
            return result;
          },
        },
      };
      const racing = await open({ crypto: racingCrypto });
      const raced = await racing.saveCheckpoint(second.token, small(8)).then(
        () => false,
        () => true,
      );
      const raw = await store.readRawRecovery("drive-set-state", "head");
      store.close();
      racing.close();
      return {
        different: first.token.identity !== second.token.identity,
        stale,
        raced,
        armed,
        headAbsent: raw === undefined,
      };
    }),
  ).toEqual({
    different: true,
    stale: true,
    raced: true,
    armed: false,
    headAbsent: true,
  });
});

test("malformed authoritative legacy head or missing bootstrap never seeds over saved data", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const raw = {
        key: "head",
        recovery: true,
        error: "old recovery",
        bytes: new Uint8Array([1, 2, 3]),
      };
      const db = await seed(2, [
        ["disk-revisions", raw],
        [
          "working-disks",
          {
            schema: "triptych-working-disk-v1",
            key: "drive-a",
            name: "valid.img",
            bytes: new Uint8Array(512),
          },
        ],
      ]);
      db.close();
      const store = await open();
      const result = await store.load();
      const rejected = await store
        .saveCheckpoint({ kind: "empty" }, small(1))
        .then(
          () => false,
          () => true,
        );
      const preserved = await store.readRawRecovery("disk-revisions", "head");
      await putRaw("disk-revisions", oldDisk(7));
      const missing = await open({ legacyBootstrap: undefined });
      const noBoot = await missing.load();
      const cannotWrite = await missing
        .saveCheckpoint({ kind: "empty" }, small(2))
        .then(
          () => false,
          () => true,
        );
      store.close();
      missing.close();
      return {
        result: result.kind,
        rejected,
        bytes: [...preserved.bytes],
        noBoot: noBoot.kind,
        cannotWrite,
      };
    }),
  ).toEqual({
    result: "recovery",
    rejected: true,
    bytes: [1, 2, 3],
    noBoot: "recovery",
    cannotWrite: true,
  });
});

test("corrupt v3 image or digest becomes raw-recoverable, never empty or writable", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open();
      await store.saveCheckpoint({ kind: "empty" }, small(1));
      const head = await store.readRawRecovery("drive-set-state", "head");
      head.digest = "a".repeat(64);
      await putRaw("drive-set-state", head);
      const badDigest = await store.load();
      const denied = await store
        .saveCheckpoint({ kind: "v3", revision: 1 }, small(2))
        .then(
          () => false,
          () => true,
        );
      const blob = await store.readRawRecovery(
        "drive-set-blobs",
        head.manifest.drives.A.image.sha256,
      );
      blob.bytes[511] = 99;
      await putRaw("drive-set-blobs", blob);
      const badBytes = await store.load();
      const raw = await store.readRawRecovery("drive-set-blobs", blob.sha256);
      store.close();
      return {
        badDigest: badDigest.kind,
        denied,
        badBytes: badBytes.kind,
        last: raw.bytes[511],
      };
    }),
  ).toEqual({
    badDigest: "recovery",
    denied: true,
    badBytes: "recovery",
    last: 99,
  });
});

test("v1 connection blocks schema upgrade; upgrade preserves raw stores and closes for later versions", async ({
  page,
}) => {
  await page.evaluate(async () => {
    window.oldConnection = await seed(1, [
      [
        "working-disks",
        {
          schema: "triptych-working-disk-v1",
          key: "drive-a",
          name: "v1.img",
          bytes: new Uint8Array(512).fill(7),
        },
      ],
    ]);
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
      oldConnection.close();
      const store = await pending;
      const saved = await store.load(),
        raw = await store.readRawRecovery("working-disks", "drive-a");
      const newHead = await store.readRawRecovery("drive-set-state", "head");
      const version = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 4);
        request.onerror = () => reject(request.error);
        request.onblocked = () =>
          reject(new Error("new connection did not close"));
        request.onsuccess = () => {
          resolve(request.result.version);
          request.result.close();
        };
      });
      return {
        kind: saved.token.kind,
        original: raw.bytes.every((b) => b === 7),
        promoted: newHead !== undefined,
        version,
      };
    }),
  ).toEqual({ kind: "legacy", original: true, promoted: false, version: 4 });
});
