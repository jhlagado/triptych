import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("a forged nonhead receipt at the head revision cannot authorize a retry", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        initial = await store.load(),
        one = await fixture(),
        two = await fixture(2);
      const first = await store.saveCheckpoint(
        initial.token,
        "one",
        one.manifest,
        one.blobs,
      );
      await store.saveCheckpoint(first.token, "two", two.manifest, two.blobs);
      const forged = await store.readRawRecovery(
        "disk-box-state-v1",
        "operation:one",
      );
      forged.expected = first.token;
      forged.receipt.revision = 2;
      const db = await new Promise((resolve) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("disk-box-state-v1", "readwrite");
        tx.objectStore("disk-box-state-v1").put(forged);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const before = await raw(),
        loaded = await store.load();
      const rejected = await rejects(() =>
        store.saveCheckpoint(first.token, "one", one.manifest, one.blobs),
      );
      const untouched = equal(before, await raw());
      store.close();
      return { rejected, untouched, kind: loaded.kind };
    }),
  ).toEqual({ rejected: true, untouched: true, kind: "recovery" });
});

test("metadata loads avoid image reads and capture candidate ownership before hashing", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        initial = await store.load(),
        candidate = await fixture();
      const pending = store.saveCheckpoint(
        initial.token,
        "owned",
        candidate.manifest,
        candidate.blobs,
      );
      candidate.manifest.personalDisks[0].name = "mutated";
      for (const bytes of candidate.blobs.values()) bytes.fill(9);
      initial.token.fingerprint = "0".repeat(64);
      await pending;
      const get = IDBObjectStore.prototype.get,
        getAll = IDBObjectStore.prototype.getAll;
      IDBObjectStore.prototype.get = function (...args) {
        if (this.name === "disk-box-blobs-v1")
          throw new Error("bulk read forbidden");
        return get.apply(this, args);
      };
      IDBObjectStore.prototype.getAll = function (...args) {
        if (this.name === "disk-box-blobs-v1")
          throw new Error("bulk read forbidden");
        return getAll.apply(this, args);
      };
      const loaded = await store.load();
      IDBObjectStore.prototype.get = get;
      IDBObjectStore.prototype.getAll = getAll;
      const data = await store.readPersonalDisk(
        loaded.manifest.personalDisks[0].id,
      );
      let getterCalled = false;
      const invalidToken = {
        revision: 1,
        digest: loaded.token.digest,
        get kind() {
          getterCalled = true;
          return "disk-box";
        },
      };
      const rejected = await rejects(() =>
        store.saveCheckpoint(invalidToken, "getter", empty()),
      );
      store.close();
      return {
        kind: loaded.kind,
        name: loaded.manifest.personalDisks[0].name,
        byte: data[0],
        rejected,
        getterCalled,
      };
    }),
  ).toEqual({
    kind: "ready",
    name: "Ejected work",
    byte: 1,
    rejected: true,
    getterCalled: false,
  });
});

test("lease loss during asynchronous preparation cannot publish", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const initialStore = await open(),
        initial = await initialStore.load(),
        before = await raw(),
        candidate = await fixture();
      initialStore.close();
      const interrupted = await openBox({
        name: dbName,
        lease: { isOwner: () => owner },
        crypto: {
          subtle: {
            digest: async (...args) => {
              owner = false;
              return crypto.subtle.digest(...args);
            },
          },
        },
      });
      const denied = await rejects(() =>
        interrupted.saveCheckpoint(
          initial.token,
          "lease",
          candidate.manifest,
          candidate.blobs,
        ),
      );
      interrupted.close();
      return { denied, exact: equal(before, await raw()) };
    }),
  ).toEqual({ denied: true, exact: true });
});

test("an older connection blocks upgrade until it closes", async ({ page }) => {
  expect(
    await page.evaluate(async () => {
      const old = await openOld({ name: dbName });
      old.close();
      const blocking = await new Promise((resolve) => {
        const request = indexedDB.open(dbName, 4);
        request.onsuccess = () => resolve(request.result);
      });
      blocking.onversionchange = () => {};
      let blocked;
      const observed = new Promise((resolve) => {
        blocked = resolve;
      });
      let complete = false;
      const opening = openBox({
        name: dbName,
        lease: { isOwner: () => owner },
        onBlocked: () => blocked(),
      }).then((store) => {
        complete = true;
        return store;
      });
      await observed;
      const stillWaiting = !complete;
      blocking.close();
      const store = await opening,
        loaded = await store.load();
      store.close();
      return { stillWaiting, kind: loaded.kind };
    }),
  ).toEqual({ stillWaiting: true, kind: "unadopted" });
});

test("historical evidence changed after validation aborts adoption", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const old = await openOld({ name: dbName });
      await old.saveCheckpoint(
        { kind: "empty" },
        {
          bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256) },
          drives: {
            A: { name: "old.img", bytes: new Uint8Array(256512).fill(4) },
            B: null,
          },
        },
      );
      old.close();
      const store = await open(),
        initial = await store.load(),
        candidate = await fixture(4);
      const oldBlob = (await store.readRawRecords("drive-set-blobs-v4")).find(
        (row) => row.bytes.length === 256512,
      );
      oldBlob.bytes[0] = 9;
      const transaction = IDBDatabase.prototype.transaction;
      let injected = false;
      IDBDatabase.prototype.transaction = function (names, mode, ...rest) {
        if (
          !injected &&
          mode === "readwrite" &&
          Array.from(names).includes("disk-box-state-v1")
        ) {
          injected = true;
          const mutation = transaction.call(
            this,
            "drive-set-blobs-v4",
            "readwrite",
          );
          mutation.objectStore("drive-set-blobs-v4").put(oldBlob);
        }
        return transaction.call(this, names, mode, ...rest);
      };
      const rejected = await rejects(() =>
        store.commitChange(
          initial.token,
          "adopt",
          candidate.manifest,
          candidate.blobs,
        ),
      );
      IDBDatabase.prototype.transaction = transaction;
      const rows = await store.readRawRecords("disk-box-state-v1"),
        blobs = await store.readRawRecords("disk-box-blobs-v1");
      store.close();
      return { injected, rejected, rows: rows.length, blobs: blobs.length };
    }),
  ).toEqual({ injected: true, rejected: true, rows: 0, blobs: 0 });
});

test("damaged activation never falls back and raw library metadata remains exportable", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        initial = await store.load();
      await store.saveCheckpoint(initial.token, "activate", empty());
      const db = await new Promise((resolve) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("disk-box-state-v1", "readwrite");
        tx.objectStore("disk-box-state-v1").delete("activation");
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const loaded = await store.load(),
        retry = await rejects(() =>
          store.saveCheckpoint(initial.token, "activate", empty()),
        );
      const rows = await store.readRawRecords("disk-box-state-v1");
      store.close();
      return {
        kind: loaded.kind,
        retry,
        raw: rows.some((row) => row.key === "head"),
      };
    }),
  ).toEqual({ kind: "recovery", retry: true, raw: true });
});

test.beforeEach(async ({ page }) => {
  const modules = [
    "disk-box-store.js",
    "disk-box.js",
    "disk-catalogue.js",
    "saved-machine-store.js",
    "saved-machine.js",
    "drive-set-v4.js",
    "drive-set.js",
    "working-disk-store.js",
  ];
  const sources = new Map(
    await Promise.all(
      modules.map(async (name) => [
        name,
        await readFile(
          new URL(
            `../../../crates/triptych-host-wasm/web/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      ]),
    ),
  );
  await page.route("https://disk-box.test/**", (route) => {
    const name = new URL(route.request().url()).pathname.slice(1);
    return route.fulfill({
      contentType: sources.has(name) ? "text/javascript" : "text/html",
      body:
        sources.get(name) ?? "<!doctype html><title>Isolated disk box</title>",
    });
  });
  await page.goto("https://disk-box.test/");
  await page.evaluate(async () => {
    window.openBox = (await import("/disk-box-store.js")).openDiskBoxStore;
    window.openOld = (
      await import("/saved-machine-store.js")
    ).openSavedMachineStore;
    window.empty = (await import("/disk-box.js")).emptyDiskBox;
    window.dbName = `disk-box-${crypto.randomUUID()}`;
    window.owner = true;
    window.open = () =>
      openBox({ name: dbName, lease: { isOwner: () => owner } });
    window.hash = async (bytes) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    window.fixture = async (byte = 1) => {
      const bytes = new Uint8Array(256512).fill(byte),
        sha256 = await hash(bytes);
      const manifest = empty();
      manifest.personalDisks.push({
        id: "550e8400-e29b-41d4-a716-446655440000",
        name: "Ejected work",
        geometry: "ibm3740",
        content: { sha256, byteLength: bytes.length },
      });
      return { manifest, blobs: new Map([[sha256, bytes]]) };
    };
    window.raw = async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const names = Array.from(db.objectStoreNames),
            tx = db.transaction(names, "readonly"),
            rows = {};
          for (const name of names) {
            const request = tx.objectStore(name).getAll();
            request.onsuccess = () => {
              rows[name] = request.result;
            };
          }
          tx.oncomplete = () => resolve(rows);
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    };
    window.equal = (a, b) => {
      if (Object.is(a, b)) return true;
      if (!a || !b || typeof a !== "object" || typeof b !== "object")
        return false;
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
      );
    };
    window.rejects = async (action) => {
      try {
        await action();
        return false;
      } catch {
        return true;
      }
    };
  });
});

test("published-only activation stores metadata, ejected private disks persist, retries never rewind", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        initial = await store.load();
      const manifest = empty();
      const image = {
        id: "system",
        revision: "v1",
        name: "Protected",
        geometry: "ibm3740",
        byteLength: 256512,
        sha256: "1".repeat(64),
        url: "https://example.org/system.img",
        source: "https://example.org/source",
        license: "MIT",
        systemProfile: "legacy-e400",
      };
      manifest.configurations.push({
        id: "550e8400-e29b-41d4-a716-446655440001",
        name: "Published only",
        configuredCount: 2,
        bootstrap: { profile: "legacy-e400", bytes: Array(256).fill(0) },
        systemDisk: { kind: "published", image },
        slots: [{ kind: "published", image }, null],
      });
      manifest.selectedConfigurationId = manifest.configurations[0].id;
      const first = await store.saveCheckpoint(
        initial.token,
        "published",
        manifest,
      );
      const noPersonal =
        (await store.readRawRecords("disk-box-blobs-v1")).length === 0;
      const added = await fixture(),
        second = await store.commitChange(
          first.token,
          "private",
          added.manifest,
          added.blobs,
        );
      const restored = await store.readPersonalDisk(
        added.manifest.personalDisks[0].id,
      );
      restored.fill(7);
      const ownCopy =
        (
          await store.readPersonalDisk(added.manifest.personalDisks[0].id)
        )[0] === 1;
      const before = await raw(),
        retry = await store.saveCheckpoint(
          initial.token,
          "published",
          manifest,
        );
      const untouched = equal(before, await raw());
      const stale = await rejects(() =>
        store.commitChange(first.token, "stale", manifest),
      );
      const collision = await rejects(() =>
        store.commitChange(first.token, "private", manifest),
      );
      const backups = await store.listBackups();
      const backup = await store.readBackup(backups[0].id);
      store.close();
      const reopened = await open(),
        head = await reopened.load();
      const retained = (
        await reopened.readPersonalDisk(added.manifest.personalDisks[0].id)
      )[0];
      reopened.close();
      return {
        initial: initial.kind,
        noPersonal,
        ownCopy,
        untouched,
        stale,
        collision,
        superseded: retry.status,
        token: equal(retry.token, second.token),
        backup: equal(backup, manifest),
        head: head.token.revision,
        retained,
      };
    }),
  ).toEqual({
    initial: "unadopted",
    noPersonal: true,
    ownCopy: true,
    untouched: true,
    stale: true,
    collision: true,
    superseded: "superseded",
    token: true,
    backup: true,
    head: 2,
    retained: 1,
  });
});

test("transaction abort and quota preserve prior state; lost response retry is exact", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        initial = await store.load(),
        one = await fixture();
      const first = await store.saveCheckpoint(
        initial.token,
        "one",
        one.manifest,
        one.blobs,
      );
      const two = await fixture(2),
        before = await raw();
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "disk-box-state-v1")
          throw new DOMException("quota", "QuotaExceededError");
        return put.apply(this, args);
      };
      const quota = await rejects(() =>
        store.commitChange(first.token, "quota", two.manifest, two.blobs),
      );
      IDBObjectStore.prototype.put = put;
      const quotaExact = equal(before, await raw());
      IDBObjectStore.prototype.put = function (...args) {
        const request = put.apply(this, args);
        if (this.name === "disk-box-state-v1") this.transaction.abort();
        return request;
      };
      const aborted = await rejects(() =>
        store.commitChange(first.token, "abort", two.manifest, two.blobs),
      );
      IDBObjectStore.prototype.put = put;
      const abortExact = equal(before, await raw());
      await store.commitChange(first.token, "lost", two.manifest, two.blobs); // Discard the response.
      const committed = await raw();
      const receipt = await store.commitChange(
        first.token,
        "lost",
        two.manifest,
        two.blobs,
      );
      const retryExact = equal(committed, await raw());
      store.close();
      return {
        quota,
        quotaExact,
        aborted,
        abortExact,
        retryExact,
        status: receipt.status,
        revision: receipt.token.revision,
      };
    }),
  ).toEqual({
    quota: true,
    quotaExact: true,
    aborted: true,
    abortExact: true,
    retryExact: true,
    status: "committed",
    revision: 2,
  });
});

test("ownership fences upgrade and writes; version-four data and raw recovery survive adoption", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      owner = false;
      const absent = await rejects(() => open());
      const notCreated = !(await indexedDB.databases()).some(
        (db) => db.name === dbName,
      );
      const old = await openOld({ name: dbName });
      await old.saveCheckpoint(
        { kind: "empty" },
        {
          bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256) },
          drives: {
            A: { name: "old.img", bytes: new Uint8Array(256512).fill(4) },
            B: null,
          },
        },
      );
      old.close();
      const before = await raw(),
        reader = await open(),
        inherited = await reader.load();
      const readerWrite = await rejects(() =>
        reader.saveCheckpoint(inherited.token, "no", empty()),
      );
      reader.close();
      const stillFour =
        (await indexedDB.databases()).find((db) => db.name === dbName)
          .version === 4;
      owner = true;
      const writer = await open(),
        unadopted = await writer.load();
      const olderFenced = await rejects(() => openOld({ name: dbName }));
      const fresh = await fixture(4);
      await writer.commitChange(
        unadopted.token,
        "adopt",
        fresh.manifest,
        fresh.blobs,
      );
      const after = await raw();
      const retained = Object.keys(before).every((name) =>
        equal(before[name], after[name]),
      );
      const recovered = await writer.historical.load();
      const exportable =
        (await writer.readRawRecords("drive-set-state-v4")).length > 0;
      owner = false;
      const leaseLost = await rejects(async () =>
        writer.saveCheckpoint((await writer.load()).token, "denied", empty()),
      );
      writer.close();
      return {
        absent,
        notCreated,
        readerWrite,
        stillFour,
        olderFenced,
        retained,
        exportable,
        leaseLost,
        historical: recovered.kind,
        unadopted: unadopted.kind,
      };
    }),
  ).toEqual({
    absent: true,
    notCreated: true,
    readerWrite: true,
    stillFour: true,
    olderFenced: true,
    retained: true,
    exportable: true,
    leaseLost: true,
    historical: "ready",
    unadopted: "unadopted",
  });
});

test("corrupt blobs block reads and retries while raw recovery remains available", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await open(),
        initial = await store.load(),
        one = await fixture();
      const first = await store.saveCheckpoint(
        initial.token,
        "one",
        one.manifest,
        one.blobs,
      );
      const key = one.manifest.personalDisks[0].content.sha256;
      const db = await new Promise((resolve) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("disk-box-blobs-v1", "readwrite");
        tx.objectStore("disk-box-blobs-v1").put({
          sha256: key,
          bytes: new Uint8Array(256512).fill(9),
        });
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      db.close();
      const readRejected = await rejects(() =>
        store.readPersonalDisk(one.manifest.personalDisks[0].id),
      );
      const retryRejected = await rejects(() =>
        store.saveCheckpoint(initial.token, "one", one.manifest, one.blobs),
      );
      const rawBytes = await store.readRawRecovery("disk-box-blobs-v1", key);
      const current = await store.load();
      store.close();
      return {
        readRejected,
        retryRejected,
        raw: rawBytes.bytes[0],
        currentRevision: current.token.revision,
        expectedRevision: first.token.revision,
      };
    }),
  ).toEqual({
    readRejected: true,
    retryRejected: true,
    raw: 9,
    currentRevision: 1,
    expectedRevision: 1,
  });
});
