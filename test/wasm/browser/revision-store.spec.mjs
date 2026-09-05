import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.route("**/revision-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Disposable storage test</title>",
    }),
  );
  for (const filename of [
    "working-disk-store.js",
    "working-disk-revisions.js",
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
  await page.goto("/revision-test");
  await page.evaluate(async () => {
    window.openStore = (
      await import("/working-disk-revisions.js")
    ).openRevisionedDiskStore;
    window.diskName = `revision-pilot-${crypto.randomUUID()}`;
    window.disk = (byte) => ({
      name: `${byte}.img`,
      bytes: new Uint8Array(512).fill(byte),
    });
    window.seedLegacy = async (record) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(diskName, 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("working-disks", { keyPath: "key" });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("working-disks", "readwrite");
          tx.objectStore("working-disks").put(record);
          tx.oncomplete = () => resolve(db);
          tx.onabort = () => reject(tx.error);
        };
      });
  });
});

test("checkpoints copy bytes; a change backs up actual head and survives reopening", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      let store = await openStore({ name: diskName });
      const empty = await store.load();
      const source = disk(1);
      const save = store.saveCheckpoint(0, source);
      source.bytes.fill(99);
      const first = await save;
      const second = await store.commitChange(1, "import-one", disk(2));
      const backups = await store.listBackups();
      store.close();
      store = await openStore({ name: diskName });
      const current = await store.load();
      const backup = await store.readBackup("import-one");
      current.bytes.fill(80);
      const reread = await store.load();
      store.close();
      return {
        empty,
        first: [first.revision, first.bytes[0]],
        second: second.revision,
        backups,
        backup: [backup.revision, backup.bytes[0]],
        current: reread.bytes[0],
      };
    }),
  ).toEqual({
    empty: undefined,
    first: [1, 1],
    second: 2,
    backups: [
      { operationId: "import-one", name: "1.img", revision: 1, bytes: 512 },
    ],
    backup: [1, 1],
    current: 2,
  });
});

test("two connections cannot publish a stale checkpoint or change", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const a = await openStore({ name: diskName });
      const b = await openStore({ name: diskName });
      const results = await Promise.allSettled([
        a.saveCheckpoint(0, disk(1)),
        b.saveCheckpoint(0, disk(2)),
      ]);
      const stale = await b.commitChange(0, "stale", disk(3)).then(
        () => "accepted",
        (e) => e.message,
      );
      const value = await a.load();
      const backups = await a.listBackups();
      a.close();
      b.close();
      return {
        statuses: results.map((r) => r.status).sort(),
        stale,
        revision: value.revision,
        backups,
      };
    }),
  ).toEqual({
    statuses: ["fulfilled", "rejected"],
    stale: "Stale disk revision; reload the committed disk.",
    revision: 1,
    backups: [],
  });
});

test("operation retry returns its original receipt without overwriting a newer head", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await openStore({ name: diskName });
      await store.saveCheckpoint(0, disk(1));
      await store.commitChange(1, "retry", disk(2));
      await store.saveCheckpoint(2, disk(3));
      const retry = await store.commitChange(1, "retry", disk(2));
      const mismatches = [];
      for (const [rev, value] of [
        [1, disk(4)],
        [2, disk(2)],
        [1, { ...disk(2), name: "renamed.img" }],
      ]) {
        mismatches.push(
          await store.commitChange(rev, "retry", value).then(
            () => false,
            () => true,
          ),
        );
      }
      const current = await store.load();
      const backups = await store.listBackups();
      store.close();
      return {
        retry: retry.revision,
        current: [current.revision, current.bytes[0]],
        mismatches,
        backups: backups.length,
      };
    }),
  ).toEqual({
    retry: 2,
    current: [3, 3],
    mismatches: [true, true, true],
    backups: 1,
  });
});

for (const failure of ["abort", "quota", "duplicate-key"]) {
  test(`${failure} after head write rolls back both head and backup; retry is safe`, async ({
    page,
  }) => {
    const unhandled = [];
    page.on("pageerror", (error) => unhandled.push(error.message));
    expect(
      await page.evaluate(async (failure) => {
        const store = await openStore({ name: diskName });
        await store.saveCheckpoint(0, disk(1));
        const original = IDBObjectStore.prototype.add;
        IDBObjectStore.prototype.add = function (...args) {
          if (this.name === "disk-revisions") {
            if (failure === "duplicate-key") {
              // The first request succeeds, the duplicate fails asynchronously
              // after the replacement head was queued in this transaction.
              original.apply(this, args);
              return original.apply(this, args);
            }
            if (failure === "quota")
              throw new DOMException(
                "Injected full storage",
                "QuotaExceededError",
              );
            this.transaction.abort();
            return undefined;
          }
          return original.apply(this, args);
        };
        let rejected;
        try {
          await store.commitChange(1, "failure", disk(2));
          rejected = false;
        } catch {
          rejected = true;
        } finally {
          IDBObjectStore.prototype.add = original;
        }
        const unchanged = await store.load();
        const absent = await store.listBackups();
        const retry = await store.commitChange(1, "failure", disk(2));
        store.close();
        return {
          rejected,
          unchanged: [unchanged.revision, unchanged.bytes[0]],
          backups: absent.length,
          retry: retry.revision,
        };
      }, failure),
    ).toEqual({ rejected: true, unchanged: [1, 1], backups: 0, retry: 2 });
    expect(unhandled).toEqual([]);
  });
}

test("version 1 tab visibly blocks migration, then legacy bytes migrate without deletion", async ({
  page,
}) => {
  await page.evaluate(async () => {
    window.oldConnection = await seedLegacy({
      schema: "triptych-working-disk-v1",
      key: "drive-a",
      ...disk(7),
    });
    window.blocked = "";
    window.pendingUpgrade = openStore({
      name: diskName,
      onBlocked: (message) => {
        window.blocked = message;
      },
    });
  });
  await expect
    .poll(() => page.evaluate(() => window.blocked))
    .toContain("Close older Triptych tabs");
  expect(
    await page.evaluate(async () => {
      oldConnection.close();
      const store = await pendingUpgrade;
      const migrated = await store.load();
      const legacy = await store.loadLegacyRecord();
      store.close();
      return {
        revision: migrated.revision,
        operation: migrated.operationId,
        bytes: migrated.bytes[0],
        legacy: [legacy.schema, legacy.bytes[0]],
      };
    }),
  ).toEqual({
    revision: 1,
    operation: "legacy-v1",
    bytes: 7,
    legacy: ["triptych-working-disk-v1", 7],
  });
});

test("migration quota failure rejects with its cause and preserves version 1 for retry", async ({
  page,
}) => {
  const unhandled = [];
  page.on("pageerror", (error) => unhandled.push(error.message));
  expect(
    await page.evaluate(async () => {
      const old = await seedLegacy({
        schema: "triptych-working-disk-v1",
        key: "drive-a",
        ...disk(7),
      });
      old.close();
      const original = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "disk-revisions")
          throw new DOMException(
            "Injected migration storage limit",
            "QuotaExceededError",
          );
        return original.apply(this, args);
      };
      let failure;
      try {
        await openStore({ name: diskName });
        failure = "unexpected success";
      } catch (error) {
        failure = [error.name, error.message];
      } finally {
        IDBObjectStore.prototype.put = original;
      }
      const preserved = await new Promise((resolve, reject) => {
        const request = indexedDB.open(diskName, 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("working-disks", "readonly");
          const get = tx.objectStore("working-disks").get("drive-a");
          tx.oncomplete = () => {
            resolve({
              version: db.version,
              stores: [...db.objectStoreNames],
              name: get.result.name,
              bytes: [...get.result.bytes],
            });
            db.close();
          };
          tx.onabort = () => reject(tx.error);
        };
      });
      const retry = await openStore({ name: diskName });
      const migrated = await retry.load();
      retry.close();
      return {
        failure,
        preserved,
        migrated: [migrated.revision, migrated.bytes[0]],
      };
    }),
  ).toEqual({
    failure: ["QuotaExceededError", "Injected migration storage limit"],
    preserved: {
      version: 1,
      stores: ["working-disks"],
      name: "7.img",
      bytes: Array(512).fill(7),
    },
    migrated: [1, 7],
  });
  expect(unhandled).toEqual([]);
});

test("malformed legacy record remains retrievable and cannot be replaced as an empty profile", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const old = await seedLegacy({
        schema: "unknown",
        key: "drive-a",
        name: "valuable.img",
        bytes: new Uint8Array([1, 2, 3]),
      });
      old.close();
      const store = await openStore({ name: diskName });
      const errors = [];
      for (const action of [
        () => store.load(),
        () => store.saveCheckpoint(0, disk(1)),
        () => store.commitChange(0, "overwrite", disk(1)),
      ])
        errors.push(
          await action().then(
            () => "accepted",
            (e) => e.message,
          ),
        );
      const legacy = await store.loadLegacyRecord();
      store.close();
      return { errors, bytes: [...legacy.bytes], name: legacy.name };
    }),
  ).toEqual({
    errors: Array(3).fill(
      "Saved disk requires recovery: Saved working disk has an unsupported format.",
    ),
    bytes: [1, 2, 3],
    name: "valuable.img",
  });
});

test("new client closes its connection when a later upgrade requests it", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const store = await openStore({ name: diskName });
      await store.saveCheckpoint(0, disk(1));
      const version = await new Promise((resolve, reject) => {
        const request = indexedDB.open(diskName, 3);
        request.onsuccess = () => {
          resolve(request.result.version);
          request.result.close();
        };
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("Connection did not close"));
      });
      const closed = await store.load().then(
        () => false,
        () => true,
      );
      return { version, closed };
    }),
  ).toEqual({ version: 3, closed: true });
});
