import { openDownloads } from "./downloads-fixture.mjs";
import { test, expect } from "@playwright/test";
import { adoptHistoricalMachine, inspectDiskBox } from "./legacy-fixture.mjs";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeSavedMachineArchive } from "../../../crates/triptych-host-wasm/web/saved-machine.js";

async function boot(page) {
  // This suite preserves the historical writable A/B -> configurable-machine
  // migration, independently of the new protected A/C public default suite.
  await page.route("**/two-mib-historical-seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/two-mib-historical-seed");
  await page.evaluate(async () => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    const read = async (name) => {
      const response = await fetch(`/${name}`);
      if (!response.ok)
        throw new Error(`Historical seed asset unavailable: ${name}`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const store = await openDriveSetStore();
    try {
      const current = await store.load();
      if (current.kind !== "empty")
        throw new Error("Historical seed requires an empty database");
      await store.saveCheckpoint(
        { kind: "empty" },
        {
          bootstrap: {
            profile: "triptych-cpu-v0.1-8m-ab",
            bytes: await read("bootstrap-triptych-cpm-8m-ab-v1.bin"),
          },
          drives: {
            A: {
              name: "drive-a-system.img",
              bytes: await read("drive-a-system.img"),
            },
            B: {
              name: "drive-b-games.img",
              bytes: await read("drive-b-games.img"),
            },
          },
        },
      );
    } finally {
      store.close();
    }
  });
  await page.unroute("**/two-mib-historical-seed");
  await adoptHistoricalMachine(page);
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
    const { openDiskBoxAppStore } = await import("/disk-box-app-store.js");
    const store = await openDiskBoxAppStore({
      lease: { isOwner: () => false },
    });
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

async function gamesFiles(page) {
  return page.evaluate(async () => {
    const { openDiskBoxAppStore } = await import("/disk-box-app-store.js");
    const { CpmDisk } = await import("/triptych_host_wasm.js");
    const store = await openDiskBoxAppStore({
      lease: { isOwner: () => false },
    });
    try {
      const { snapshot } = await store.load();
      const image = snapshot.slots ? snapshot.slots[1] : snapshot.drives.B;
      const disk = new CpmDisk(image.bytes);
      try {
        const entries = [];
        for (const name of disk.file_names().sort()) {
          const digest = await crypto.subtle.digest(
            "SHA-256",
            disk.read_file(name),
          );
          entries.push([name, Array.from(new Uint8Array(digest))]);
        }
        return entries;
      } finally {
        disk.free();
      }
    } finally {
      store.close();
    }
  });
}

test("adopted historical A/B configuration preserves games, runs sparse P and restores removed media from an archive", async ({
  page,
}, info) => {
  page.on("dialog", (dialog) => dialog.accept());
  await boot(page);
  const originalGames = await gamesFiles(page);
  expect(originalGames.map(([name]) => name)).toEqual([
    "CAVERNS.COM",
    "HYPERD2.COM",
    "HYPERDRV.COM",
    "README.TXT",
  ]);
  await manage(page);
  await configure(page, 4);
  await apply(page);
  const four = await metadata(page);
  expect(four.count).toBe(4);
  expect(four.slots[1].name).toBe("drive-b-games.img");
  expect(four.slots.slice(2)).toEqual([null, null]);
  expect(await gamesFiles(page)).toEqual(originalGames);
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
  expect(sixteen.slots[1]).toEqual(four.slots[1]);
  expect(sixteen.slots.slice(2, 15)).toEqual(Array(13).fill(null));
  expect(await gamesFiles(page)).toEqual(originalGames);
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
  await openDownloads(page);
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
  await openDownloads(page);
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
    if (index === 1) {
      await page.locator("#eject-drive").click();
      await expect(page.locator("#files-status")).toContainText(
        "B ejection staged",
      );
    }
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
        const request = indexedDB.open("triptych-cpu");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const transaction = db.transaction("disk-box-blobs-v1", "readonly");
          const request = transaction.objectStore("disk-box-blobs-v1").count();
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
  await expect(page.locator("#files-dialog")).toBeHidden();
  const pending = page.waitForEvent("download");
  const archiveStarted = Date.now();
  await openDownloads(page);
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
        this.name === "disk-box-state-v1" &&
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
  await page.locator("#eject-drive").click();
  await expect(page.locator("#files-status")).toContainText(
    "B ejection staged",
  );
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

test("a genuine v3 saved head adopts without replacement assets or changing historical records", async ({
  page,
}) => {
  await page.route("**/v3-historical-seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/v3-historical-seed");
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
  await page.goto("/");
  await expect(page.locator("#adopt-disks")).toBeVisible();
  expect((await inspectDiskBox(page)).kind).toBe("unadopted");
  expect(await historical()).toEqual(before);
  await adoptHistoricalMachine(page, { navigate: false });
  const adopted = await metadata(page);
  expect(adopted.token.kind).toBe("disk-box");
  expect(adopted.profile).toBe("legacy-e400");
  await manage(page);
  const promoted = await metadata(page);
  expect(promoted.token.kind).toBe("disk-box");
  // DB5 adoption retains the original historical authority in place, rather
  // than manufacturing the old v4 checkpoint-promotion backup. Subsequent
  // ordinary checkpoints must not change that historical recovery evidence.
  expect(promoted.backups).toEqual(adopted.backups);
  expect(await historical()).toEqual(before);
  expect(freshRequests).toBe(0);
});
