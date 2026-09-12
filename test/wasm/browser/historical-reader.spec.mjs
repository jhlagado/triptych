import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test.beforeEach(async ({ page }) => {
  await page.route("**/historical-reader-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Historical reader</title>",
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
  await page.goto("/historical-reader-test");
  await page.evaluate(async () => {
    window.readerModule = await import("/saved-machine-store.js");
    window.oldModule = await import("/drive-set-store.js");
    window.dbName = `reader-${crypto.randomUUID()}`;
    window.boot = new Uint8Array(256).fill(42);
    window.snapshot = (byte) => ({
      bootstrap: { profile: "legacy-e400", bytes: boot },
      drives: {
        A: { name: "saved.img", bytes: new Uint8Array(512).fill(byte) },
        B: null,
      },
    });
    window.connect = (version, upgrade = () => {}) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, version);
        request.onupgradeneeded = () => upgrade(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    window.put = (db, store, value) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(store, "readwrite");
        tx.objectStore(store).put(value);
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
    window.raw = (db) =>
      new Promise((resolve, reject) => {
        const names = [...db.objectStoreNames];
        if (!names.length) return resolve({});
        const tx = db.transaction(names, "readonly"),
          rows = {};
        for (const name of names) {
          const request = tx.objectStore(name).getAll();
          request.onsuccess = () => {
            rows[name] = request.result;
          };
        }
        tx.oncomplete = () => resolve(JSON.stringify(rows));
        tx.onabort = () => reject(tx.error);
      });
    window.boxStores = (db) => {
      db.createObjectStore("disk-box-state-v1", { keyPath: "key" });
      db.createObjectStore("disk-box-blobs-v1", { keyPath: "sha256" });
    };
    window.seed = async (version) => {
      if (version < 3) {
        const store = version === 1 ? "working-disks" : "disk-revisions";
        const db = await connect(version, (db) =>
          db.createObjectStore(store, { keyPath: "key" }),
        );
        await put(db, store, {
          key: version === 1 ? "drive-a" : "head",
          schema: `triptych-working-disk-v${version}`,
          name: "legacy.img",
          bytes: new Uint8Array(512).fill(version),
          ...(version === 2 ? { revision: 3, operationId: "old" } : {}),
        });
        return db;
      }
      const publisher = await (
        version === 3
          ? oldModule.openDriveSetStore
          : readerModule.openSavedMachineStore
      )({ name: dbName });
      const first = await publisher.saveCheckpoint(
        { kind: "empty" },
        snapshot(3),
      );
      await publisher.commitChange(
        version === 3 ? { kind: "v3", revision: first.revision } : first.token,
        "replace",
        snapshot(4),
      );
      publisher.close();
      return connect(version, version === 5 ? boxStores : undefined);
    };
  });
});

for (const version of [1, 2, 3, 4, 5]) {
  test(`caller-owned reader preserves historical records at database version ${version}`, async ({
    page,
  }) => {
    expect(
      await page.evaluate(async (version) => {
        const db = await seed(version);
        const before = await raw(db);
        const txModes = [],
          transaction = db.transaction.bind(db);
        let closes = 0;
        const close = db.close.bind(db);
        db.close = () => {
          closes++;
          close();
        };
        db.transaction = (stores, mode, ...rest) => {
          txModes.push(mode);
          return transaction(stores, mode, ...rest);
        };
        const reader = readerModule.createSavedMachineReader(db, {
          legacyBootstrap: boot,
        });
        const loaded = await reader.load();
        const backups = await reader.listBackups();
        let backupExact = true;
        if (version >= 3) {
          const backup = await reader.readBackup(
            `v${version === 5 ? 4 : version}:replace`,
          );
          backupExact = backup.drives.A.bytes.every((byte) => byte === 3);
        }
        const missing = await readerModule.createSavedMachineReader(db).load();
        const historical = [
          "working-disks",
          "disk-revisions",
          "drive-set-state",
          "drive-set-blobs",
          "drive-set-state-v4",
          "drive-set-blobs-v4",
        ];
        let rawExact = true;
        const beforeRows = JSON.parse(before);
        for (const name of historical) {
          const rows = await reader.readRawRecords(name);
          rawExact &&=
            JSON.stringify(rows) === JSON.stringify(beforeRows[name] ?? []);
          for (const row of rows)
            rawExact &&=
              JSON.stringify(
                await reader.readRawRecovery(name, row.key ?? row.sha256),
              ) === JSON.stringify(row);
        }
        let whitelist = false;
        try {
          await reader.readRawRecords("disk-box-state-v1");
        } catch {
          whitelist = true;
        }
        const result = {
          kind: loaded.kind,
          bytes: loaded.snapshot.drives.A.bytes.every(
            (byte) => byte === (version < 3 ? version : 4),
          ),
          backups: backups.length,
          backupExact,
          rawExact,
          unchanged: before === (await raw(db)),
          onlyReads: txModes.every((mode) => mode === "readonly"),
          closes,
          missingBootstrap:
            version < 3
              ? missing.code === "HISTORICAL_BOOTSTRAP_REQUIRED"
              : missing.kind === "ready",
          methods: Object.keys(reader).sort(),
          whitelist,
          version: db.version,
        };
        close();
        return result;
      }, version),
    ).toEqual({
      kind: "ready",
      bytes: true,
      backups: version < 3 ? 0 : 1,
      backupExact: true,
      rawExact: true,
      unchanged: true,
      onlyReads: true,
      closes: 0,
      missingBootstrap: true,
      methods: [
        "listBackups",
        "load",
        "readBackup",
        "readRawRecords",
        "readRawRecovery",
      ],
      whitelist: true,
      version,
    });
  });
}

test("absent historical stores are empty and do not expose new authority rows", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const db = await connect(5, boxStores);
      await put(db, "disk-box-state-v1", {
        key: "head",
        private: "new authority",
      });
      const reader = readerModule.createSavedMachineReader(db);
      const result = {
        loaded: await reader.load(),
        backups: await reader.listBackups(),
        rows: await reader.readRawRecords("drive-set-state-v4"),
        missing: await reader.readRawRecovery("working-disks", "drive-a"),
      };
      db.close();
      return result;
    }),
  ).toEqual({
    loaded: { kind: "empty", token: { kind: "empty" } },
    backups: [],
    rows: [],
    missing: undefined,
  });
});

test("corrupt heads and backups remain available without validation or writes", async ({
  page,
}) => {
  expect(
    await page.evaluate(async () => {
      const db = await seed(5);
      const state = "drive-set-state-v4";
      const badHead = { key: "head", broken: new Uint8Array([1, 2, 3]) };
      const badBackup = { key: "backup:broken", unexpected: "retain me" };
      await put(db, state, badHead);
      await put(db, state, badBackup);
      const before = await raw(db);
      const reader = readerModule.createSavedMachineReader(db);
      const result = {
        recovery: (await reader.load()).kind === "recovery",
        rawHead:
          JSON.stringify(await reader.readRawRecovery(state, "head")) ===
          JSON.stringify(badHead),
        rawBackup: (await reader.readRawRecords(state)).some(
          (row) => JSON.stringify(row) === JSON.stringify(badBackup),
        ),
        backupReported: (await reader.listBackups()).some(
          (row) => row.id === "v4:broken" && row.kind === "recovery",
        ),
        unchanged: before === (await raw(db)),
      };
      db.close();
      return result;
    }),
  ).toEqual({
    recovery: true,
    rawHead: true,
    rawBackup: true,
    backupReported: true,
    unchanged: true,
  });
});
