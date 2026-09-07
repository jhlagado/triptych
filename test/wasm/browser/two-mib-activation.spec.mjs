import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeSavedMachineArchive } from "../../../crates/triptych-host-wasm/web/saved-machine.js";

async function boot(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await expect(page.locator("#terminal")).toContainText("A>");
}
async function manage(page) {
  if (!(await page.locator("#files-dialog").isVisible()))
    await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#configure-drives")).toBeEnabled();
}
async function apply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await expect(page.locator("#terminal")).toContainText("A>");
}
async function configure(page, count) {
  await page.locator("#configured-count").fill(String(count));
  await page.locator("#configure-drives").click();
  await expect(page.locator("#files-status")).toContainText(
    `${count} two-MiB slots staged`,
  );
}
async function metadata(page) {
  return page.evaluate(async () => {
    const { openSavedMachineStore } = await import("/saved-machine-store.js");
    const store = await openSavedMachineStore();
    try {
      const state = await store.load();
      if (state.kind !== "ready") throw new Error(JSON.stringify(state));
      const { snapshot } = state;
      return {
        token: state.token,
        profile: snapshot.bootstrap.profile,
        count: snapshot.configuredCount,
        slots: snapshot.slots?.map(
          (slot) => slot && { name: slot.name, instanceId: slot.instanceId },
        ),
        backups: await store.listBackups(),
      };
    } finally {
      store.close();
    }
  });
}

test("public configuration runs sparse P, saves files and restores removed media from an archive", async ({
  page,
}, info) => {
  page.on("dialog", (dialog) => dialog.accept());
  await boot(page);
  await manage(page);
  await configure(page, 4);
  await apply(page);
  const four = await metadata(page);
  expect(four.count).toBe(4);
  expect(four.slots.slice(1)).toEqual([null, null, null]);
  await manage(page);
  await configure(page, 16);
  await page.locator("#file-drive").selectOption("P");
  await page.locator("#blank-drive").click();
  await expect(page.locator("#files-status")).toContainText("Blank P staged");
  await page.locator("#file-import").setInputFiles({
    name: "NOTE.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("P-DRIVE-PERSISTENCE\r\n"),
  });
  await expect(page.locator("#files-status")).toContainText("Staged NOTE.TXT");
  await apply(page);
  const sixteen = await metadata(page);
  expect(sixteen.count).toBe(16);
  await expect(page.locator("#configured-count")).toHaveValue("16", {
    timeout: 1000,
  });
  await expect(page.locator("#machine-summary")).toContainText(
    "16 configured slots",
  );
  await expect(page.locator("#machine-summary")).toContainText("56576 bytes");
  expect(sixteen.slots[0].instanceId).toBe(four.slots[0].instanceId);
  expect(sixteen.slots.slice(1, 15)).toEqual(Array(14).fill(null));
  await page.locator("#close-files").click();
  await page.locator("#terminal").focus();
  await page.keyboard.type("TYPE P:NOTE.TXT");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("P-DRIVE-PERSISTENCE");
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  expect((await metadata(page)).slots).toEqual(sixteen.slots);
  await expect(page.locator("#configured-count")).toHaveValue("16");
  await expect(page.locator("#machine-summary")).toContainText("56576 bytes");
  const downloaded = page.waitForEvent("download");
  await page.locator("#download-set").click();
  const download = await downloaded;
  const path = info.outputPath("sixteen.tds");
  await download.saveAs(path);
  const archive = await decodeSavedMachineArchive(await readFile(path));
  expect(archive.configuredCount).toBe(16);
  expect(archive.slots[15].instanceId).toBe(sixteen.slots[15].instanceId);
  await manage(page);
  await configure(page, 2);
  await apply(page);
  expect((await metadata(page)).count).toBe(2);
  await manage(page);
  await page.locator("#drive-set-input").setInputFiles(path);
  await expect(page.locator("#files-status")).toContainText(
    "Complete drive set staged",
  );
  await apply(page);
  expect((await metadata(page)).slots).toEqual(sixteen.slots);
});

test("saved two-MiB media reopen without fresh system fetches and remain downloadable if admission is unavailable", async ({
  page,
}, info) => {
  page.on("dialog", (dialog) => dialog.accept());
  await boot(page);
  await manage(page);
  await configure(page, 2);
  await apply(page);
  const before = await metadata(page);
  let freshRequests = 0;
  await page.route(
    /\/(?:bootstrap(?:-.*)?\.bin|system-.*\.bin|cpm22\.img|config\.json|ccp\.bin|bdos\.bin|bios\.bin)$/,
    (route) => {
      freshRequests++;
      return route.abort();
    },
  );
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  expect(freshRequests).toBe(0);
  await page.route("**/deployment-manifest.json", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    delete value.twoMibProfiles;
    await route.fulfill({ response, json: value });
  });
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  expect(await metadata(page)).toEqual(before);
  expect(freshRequests).toBe(0);
  const downloaded = page.waitForEvent("download");
  await page.locator("#download-set").click();
  const download = await downloaded;
  const path = info.outputPath("unavailable-profile.tds");
  await download.saveAs(path);
  const snapshot = await decodeSavedMachineArchive(await readFile(path));
  expect(snapshot.configuredCount).toBe(2);
  expect(snapshot.slots[0].instanceId).toBe(before.slots[0].instanceId);
});

test("all sixteen independent images survive checkpoint, archive and rejected reduction", async ({
  page,
}, info) => {
  page.on("dialog", (dialog) => dialog.accept());
  await boot(page);
  await manage(page);
  await configure(page, 16);
  const started = Date.now();
  const timing = {};
  const heapSamples = [];
  for (let index = 1; index < 16; index++) {
    const letter = String.fromCharCode(65 + index);
    await page.locator("#file-drive").selectOption(letter);
    await page.locator("#blank-drive").click();
    await expect(page.locator("#files-status")).toContainText(
      `Blank ${letter} staged`,
    );
    await page.locator("#file-import").setInputFiles({
      name: "WHO.TXT",
      mimeType: "text/plain",
      buffer: Buffer.from(`Drive ${letter}\r\n`),
    });
    await expect(page.locator("#files-status")).toContainText("Staged WHO.TXT");
    heapSamples.push(
      await page.evaluate(() => performance.memory?.usedJSHeapSize ?? null),
    );
  }
  const applyStarted = Date.now();
  await apply(page);
  timing.applyAndRebootMs = Date.now() - applyStarted;
  const complete = await metadata(page);
  expect(complete.slots).toHaveLength(16);
  expect(complete.slots.every(Boolean)).toBe(true);
  expect(new Set(complete.slots.map((slot) => slot.instanceId)).size).toBe(16);
  const blobCount = () =>
    page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("triptych-cpu", 4);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction("drive-set-blobs-v4", "readonly");
          const request = transaction.objectStore("drive-set-blobs-v4").count();
          transaction.oncomplete = () => resolve(request.result);
          transaction.onabort = () => reject(transaction.error);
        });
      } finally {
        db.close();
      }
    });
  const blobsBefore = await blobCount();
  const checkpointStarted = Date.now();
  await manage(page); // A checkpoint with unchanged bytes must reuse blobs.
  timing.unchangedCheckpointAndListingMs = Date.now() - checkpointStarted;
  expect(await blobCount()).toBe(blobsBefore);
  await page.locator("#cancel-management").click();
  await page.locator("#close-files").click();
  const pending = page.waitForEvent("download");
  const archiveStarted = Date.now();
  await page.locator("#download-set").click();
  const path = info.outputPath("all-sixteen.tds");
  await (await pending).saveAs(path);
  timing.archiveAndDownloadMs = Date.now() - archiveStarted;
  const bytes = await readFile(path);
  expect(bytes.length).toBeGreaterThan(16 * 2097152);
  const archived = await decodeSavedMachineArchive(bytes);
  const hashes = archived.slots.map((slot) =>
    createHash("sha256").update(slot.bytes).digest("hex"),
  );
  expect(new Set(hashes).size).toBe(16);
  const reloadStarted = Date.now();
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  expect((await metadata(page)).slots).toEqual(complete.slots);
  timing.reloadAndMetadataMs = Date.now() - reloadStarted;
  await manage(page);
  const beforeFailure = await metadata(page);
  await configure(page, 2);
  await page.evaluate(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, ...args) {
      if (
        this.name === "drive-set-state-v4" &&
        value?.key?.startsWith("backup:")
      ) {
        IDBObjectStore.prototype.add = add;
        throw new DOMException(
          "Sixteen-drive backup quota probe",
          "QuotaExceededError",
        );
      }
      return add.call(this, value, ...args);
    };
  });
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText(
    "Sixteen-drive backup quota probe",
  );
  expect(await metadata(page)).toEqual(beforeFailure);
  await apply(page); // Explicit retry retains the old complete sixteen-media backup.
  expect((await metadata(page)).count).toBe(2);
  await manage(page);
  await page.locator("#drive-set-input").setInputFiles(path);
  await apply(page);
  expect((await metadata(page)).slots).toEqual(complete.slots);
  await page.locator("#close-files").click();
  await page.locator("#terminal").focus();
  await page.keyboard.type("TYPE P:WHO.TXT");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("Drive P");
  const measurementPath = info.outputPath(
    "sixteen-drive-local-measurement.json",
  );
  await writeFile(
    measurementPath,
    JSON.stringify(
      {
        elapsedMs: Date.now() - started,
        timing,
        archiveBytes: bytes.length,
        distinctImageHashes: hashes.length,
        blobsBefore,
        heapSamples,
        heapScope:
          "Chromium performance.memory samples, not peak process RSS or ESP32 memory",
      },
      null,
      2,
    ),
  );
  await info.attach("sixteen-drive-local-measurement", {
    path: measurementPath,
    contentType: "application/json",
  });
});

test("historical saved startup does not wait for optional deployment metadata", async ({
  page,
}) => {
  await boot(page);
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/deployment-manifest.json", async (route) => {
    await waiting;
    await route.continue();
  });
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "running",
      { timeout: 3000 },
    );
    await expect(page.locator("#terminal")).toContainText("A>", {
      timeout: 3000,
    });
  } finally {
    release();
  }
});

test("ejection retains the configured count, capacity and complete restorable medium", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await boot(page);
  await manage(page);
  await configure(page, 2);
  await page.locator("#file-drive").selectOption("B");
  await page.locator("#blank-drive").click();
  await page.locator("#file-import").setInputFiles({
    name: "KEEP.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("EJECTED-B-RETAINED\r\n"),
  });
  await expect(page.locator("#files-status")).toContainText("Staged KEEP.TXT");
  await apply(page);
  const inserted = await metadata(page);
  await expect(page.locator("#machine-summary")).toContainText(
    "2 configured slots; inserted media: A, B",
  );
  await expect(page.locator("#machine-summary")).toContainText("58368 bytes");
  await manage(page);
  await page.locator("#eject-drive").click();
  await expect(page.locator("#files-status")).toContainText(
    "B ejection staged",
  );
  await apply(page);
  const ejected = await metadata(page);
  expect(ejected.count).toBe(2);
  expect(ejected.profile).toBe(inserted.profile);
  expect(ejected.slots).toEqual([inserted.slots[0], null]);
  await expect(page.locator("#machine-summary")).toContainText(
    "2 configured slots; inserted media: A.",
  );
  await expect(page.locator("#machine-summary")).toContainText("58368 bytes");
  await manage(page);
  await page.locator("#backup-list [data-restore]").first().click();
  await expect(page.locator("#files-status")).toContainText("staged");
  await apply(page);
  expect((await metadata(page)).slots).toEqual(inserted.slots);
  await page.locator("#close-files").click();
  await page.locator("#terminal").focus();
  await page.keyboard.type("TYPE B:KEEP.TXT");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("EJECTED-B-RETAINED");
});

test("a genuine v3 saved head starts without replacement assets and promotes without changing historical records", async ({
  page,
}) => {
  await page.route("**/app.js", (route) => route.abort());
  await page.goto("/");
  await page.evaluate(async () => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    const [bootstrap, disk] = await Promise.all(
      ["bootstrap.bin", "cpm22.img"].map(
        async (name) =>
          new Uint8Array(await (await fetch(`/${name}`)).arrayBuffer()),
      ),
    );
    const store = await openDriveSetStore();
    try {
      await store.saveCheckpoint(
        { kind: "empty" },
        {
          bootstrap: { profile: "legacy-e400", bytes: bootstrap },
          drives: { A: { name: "actual-v3.img", bytes: disk }, B: null },
        },
      );
    } finally {
      store.close();
    }
  });
  const historical = () =>
    page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("triptych-cpu");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        const rows = await new Promise((resolve, reject) => {
          const tx = db.transaction(
            ["drive-set-state", "drive-set-blobs"],
            "readonly",
          );
          const state = tx.objectStore("drive-set-state").getAll();
          const blobs = tx.objectStore("drive-set-blobs").getAll();
          tx.oncomplete = () =>
            resolve({ state: state.result, blobs: blobs.result });
          tx.onabort = () => reject(tx.error);
        });
        return Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(JSON.stringify(rows)),
            ),
          ),
        );
      } finally {
        db.close();
      }
    });
  const before = await historical();
  await page.unrouteAll();
  let freshRequests = 0;
  await page.route(
    /\/(?:bootstrap(?:-.*)?\.bin|system-.*\.bin|cpm22\.img|config\.json|ccp\.bin|bdos\.bin|bios\.bin)$/,
    (route) => {
      freshRequests++;
      return route.abort();
    },
  );
  await boot(page);
  expect((await metadata(page)).token.kind).toBe("historical");
  expect(await historical()).toEqual(before);
  await manage(page);
  const promoted = await metadata(page);
  expect(promoted.token.kind).toBe("v4");
  expect(promoted.backups).toHaveLength(1);
  expect(promoted.backups[0].operationId).toMatch(/^checkpoint:/);
  expect(await historical()).toEqual(before);
  expect(freshRequests).toBe(0);
});
