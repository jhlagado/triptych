import { expect, test } from "./legacy-fixture.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeDriveSet } from "../../../crates/triptych-host-wasm/web/drive-set.js";
import { resolve, join, extname } from "node:path";
import {
  archiveBrowserRecovery,
  verifyBrowserRecoveryArchive,
} from "../../../tools/archive-browser-recovery.mjs";
import { installCpm22File } from "../../../tools/lib/cpm22-disk.mjs";

async function stored(page) {
  return page.evaluate(async () => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    let store = await openDriveSetStore();
    try {
      let head = await store.load();
      if (
        head.kind === "recovery" &&
        head.error ===
          "Historical bootstrap is required to reopen the saved legacy disk."
      ) {
        store.close();
        const legacyBootstrap = new Uint8Array(
          await (await fetch("/bootstrap.bin")).arrayBuffer(),
        );
        store = await openDriveSetStore({ legacyBootstrap });
        head = await store.load();
      }
      if (head.kind !== "ready")
        throw new Error(`Expected ready saved state: ${JSON.stringify(head)}`);
      const backups = (await store.listBackups()).sort(
        (a, b) => b.revision - a.revision || a.id.localeCompare(b.id),
      );
      return {
        token: head.token,
        name: head.snapshot.drives.A.name,
        bName: head.snapshot.drives.B?.name ?? null,
        bytes: Array.from(head.snapshot.drives.A.bytes),
        b: head.snapshot.drives.B
          ? Array.from(head.snapshot.drives.B.bytes)
          : null,
        bootstrap: {
          profile: head.snapshot.bootstrap.profile,
          bytes: Array.from(head.snapshot.bootstrap.bytes),
        },
        backups: await Promise.all(
          backups.map(async (entry) => {
            const value = await store.readBackup(entry.id);
            return {
              ...entry,
              name: value.drives.A.name,
              bName: value.drives.B?.name ?? null,
              bytes: Array.from(value.drives.A.bytes),
              b: value.drives.B ? Array.from(value.drives.B.bytes) : null,
              bootstrap: {
                profile: value.bootstrap.profile,
                bytes: Array.from(value.bootstrap.bytes),
              },
            };
          }),
        ),
      };
    } finally {
      store.close();
    }
  });
}

test("a retained deployment reopens migrated work and backups at the same origin", async ({
  page,
}, info) => {
  const sourceDirectory = resolve("dist/wasm-browser");
  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, "deployment-manifest.json"), "utf8"),
  );
  const archiveDirectory = info.outputPath("recovery");
  const options = {
    sourceDirectory,
    archiveDirectory,
    expectedRevision: manifest.distribution.triptych.revision,
    allowDevelopment: manifest.distribution.triptych.dirty,
  };
  const receipt = await archiveBrowserRecovery(options);
  expect(receipt.intendedStorageSchema).toBe("triptych-drive-set-v3");
  const original = installCpm22File(
    await readFile(join(sourceDirectory, "cpm22.img")),
    {
      name: "KEEP.TXT",
      bytes: Buffer.from("Retained across deployment\r\n"),
      padByte: 26,
    },
  );
  await page.addInitScript((bytes) => {
    if (sessionStorage.getItem("recovery-seeded")) {
      window.legacySeed = Promise.resolve();
      return;
    }
    sessionStorage.setItem("recovery-seeded", "yes");
    window.legacySeed = new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-cpu", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("working-disks", { keyPath: "key" });
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("working-disks", "readwrite");
        tx.objectStore("working-disks").put({
          schema: "triptych-working-disk-v1",
          key: "drive-a",
          name: "previous.img",
          bytes: Uint8Array.from(bytes),
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
  }, Array.from(original));
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `await window.legacySeed;\n${await response.text()}`,
    });
  });
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  expect((await stored(page)).bytes).toEqual(Array.from(original));
  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
  await page.locator("#file-import").setInputFiles({
    name: "AFTER.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("Written after migration\r\n"),
  });
  await expect(page.locator("#commit-disk")).toBeEnabled();
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  const saved = await stored(page);
  expect(saved.backups).toHaveLength(1);
  await page.unrouteAll();
  const files = new Set([
    "deployment-manifest.json",
    ...manifest.assets.map((asset) => asset.path),
  ]);
  const served = new Set();
  const types = {
    ".js": "text/javascript",
    ".html": "text/html",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
  };
  // Replace every HTTP asset at the SAME origin from the verified archive.
  // No fallback to live served files is allowed in the recovery phase.
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const name = pathname === "/" ? "index.html" : pathname.slice(1);
    if (!files.has(name)) {
      await route.abort();
      return;
    }
    served.add(name);
    await route.fulfill({
      contentType: types[extname(name)] ?? "application/octet-stream",
      body: await readFile(join(archiveDirectory, "site", name)),
    });
  });
  await page.reload();
  await expect(page.locator("#terminal")).toContainText("A>");
  expect(await stored(page)).toEqual(saved);
  for (const name of [
    "index.html",
    "app.js",
    "drive-set-store.js",
    "triptych_host_wasm_bg.wasm",
  ])
    expect(served.has(name), `${name} served from archive`).toBe(true);
  expect(
    served.has("cpm22.img"),
    "saved work must not be replaced with distribution",
  ).toBe(false);
  await page.locator("#terminal").focus();
  await page.keyboard.type("TYPE KEEP.TXT");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText(
    "Retained across deployment",
  );
  await page.locator("#files").click();
  await expect(page.locator("#file-list")).toContainText("AFTER.TXT");
  await expect(page.locator("#backup-list [data-restore]")).toHaveCount(1);
  await verifyBrowserRecoveryArchive(options);
});

const recoveryDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

async function completeRecoveryState(page) {
  return page.evaluate(async () => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    const digest = async (bytes) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    const summarize = async (snapshot) => {
      const image = async (value) =>
        value === null
          ? null
          : {
              name: value.name,
              length: value.bytes.length,
              sha256: await digest(value.bytes),
            };
      return {
        bootstrap: {
          profile: snapshot.bootstrap.profile,
          length: snapshot.bootstrap.bytes.length,
          sha256: await digest(snapshot.bootstrap.bytes),
        },
        drives: {
          A: await image(snapshot.drives.A),
          B: await image(snapshot.drives.B),
        },
      };
    };
    // Deliberately no legacy-bootstrap fallback: these are complete v3 heads/backups.
    const store = await openDriveSetStore();
    try {
      const head = await store.load();
      if (head.kind !== "ready")
        throw new Error(`Expected complete saved set: ${JSON.stringify(head)}`);
      const backups = (await store.listBackups()).sort(
        (a, b) =>
          (b.revision ?? -1) - (a.revision ?? -1) || a.id.localeCompare(b.id),
      );
      const retained = [];
      // Read sequentially: do not retain or transfer all 8 MiB images as JSON arrays.
      for (const backup of backups) {
        if (backup.kind !== "available")
          throw new Error(`Backup unavailable: ${JSON.stringify(backup)}`);
        const value = await store.readBackup(backup.id);
        if (!value) throw new Error(`Backup missing: ${backup.id}`);
        retained.push({ ...backup, snapshot: await summarize(value) });
      }
      return {
        token: head.token,
        snapshot: await summarize(head.snapshot),
        backups: retained,
      };
    } finally {
      store.close();
    }
  });
}

async function recoveryPrompt(page, drive = "A") {
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent())
        .trimEnd()
        .endsWith(`${drive}>`),
    )
    .toBe(true);
}

async function recoveryCommand(page, command, before = "B", after = before) {
  await recoveryPrompt(page, before);
  await page.locator("#terminal").focus();
  await page.keyboard.type(command);
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent())
        .trimEnd()
        .endsWith(`${before}>${command}`),
    )
    .toBe(true);
  await page.keyboard.press("Enter");
  await recoveryPrompt(page, after);
}

async function recoveryManage(page) {
  if (!(await page.locator("#files-dialog").isVisible()))
    await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
}

async function recoveryApply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await recoveryPrompt(page);
}

async function checkCompleteArchive(bytes, expected) {
  const value = await decodeDriveSet(bytes);
  expect(value.bootstrap.profile).toBe(expected.bootstrap.profile);
  expect(value.bootstrap.bytes.length).toBe(expected.bootstrap.length);
  expect(recoveryDigest(value.bootstrap.bytes)).toBe(expected.bootstrap.sha256);
  for (const drive of ["A", "B"]) {
    if (expected.drives[drive] === null) expect(value.drives[drive]).toBeNull();
    else {
      expect(value.drives[drive].name).toBe(expected.drives[drive].name);
      expect(value.drives[drive].bytes.length).toBe(
        expected.drives[drive].length,
      );
      expect(recoveryDigest(value.drives[drive].bytes)).toBe(
        expected.drives[drive].sha256,
      );
    }
  }
}

async function completeRecoveryDownloads(page, info, phase, expected) {
  if (await page.locator("#files-dialog").isVisible())
    await page.locator("#close-files").click();
  const save = async (locator, label, snapshot) => {
    const pending = page.waitForEvent("download");
    await locator.click();
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(/\.tds$/);
    const path = info.outputPath(`${phase}-${label}.tds`);
    await download.saveAs(path);
    const bytes = await readFile(path);
    await checkCompleteArchive(bytes, snapshot);
    return bytes;
  };
  const head = await save(
    page.locator("#download-set"),
    "head",
    expected.snapshot,
  );
  await page.locator("#files").click();
  await expect(page.locator("#backup-list [data-restore]")).toHaveCount(
    expected.backups.length,
  );
  const backups = new Map();
  for (let index = 0; index < expected.backups.length; index++) {
    const backup = expected.backups[index];
    const row = page.locator("#backup-list li").nth(index);
    await expect(row).toContainText(backup.id);
    backups.set(
      backup.id,
      await save(
        row.getByRole("button", { name: "Download set", exact: true }),
        `backup-${index}`,
        backup.snapshot,
      ),
    );
  }
  await page.locator("#close-files").click();
  return { head, backups };
}

test("a retained deployment alone reopens complete A/B work and exact complete-set backups", async ({
  page,
  baseURL,
}, info) => {
  test.setTimeout(300000);
  page.on("dialog", (dialog) => dialog.accept());
  // The override qualifies an exact retained CI site without rebuilding it.
  const sourceDirectory = resolve(
    process.env.TRIPTYCH_RECOVERY_SITE_SOURCE ?? "dist/wasm-browser",
  );
  const manifest = JSON.parse(
    await readFile(join(sourceDirectory, "deployment-manifest.json"), "utf8"),
  );
  const archiveDirectory = info.outputPath("ab-recovery");
  const expectedRevision =
    process.env.TRIPTYCH_RECOVERY_EXPECTED_REVISION ??
    manifest.distribution.triptych.revision;
  expect(manifest.distribution.triptych.revision).toBe(expectedRevision);
  const options = {
    sourceDirectory,
    archiveDirectory,
    expectedRevision,
    allowDevelopment: manifest.distribution.triptych.dirty,
  };
  const receipt = await archiveBrowserRecovery(options);
  expect(receipt.intendedStorageSchema).toBe("triptych-drive-set-v3");
  const files = new Set([
    "deployment-manifest.json",
    ...manifest.assets.map((asset) => asset.path),
  ]);
  const origin = new URL(baseURL).origin;
  const types = {
    ".js": "text/javascript",
    ".html": "text/html",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
  };
  const unexpected = [];
  const forbiddenRecovery = [];
  const served = new Set();
  const siteRoute = (directory, recovering) => async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    // Only the initial historical launch uses the explicit legacy fixture.
    // Recovery must still reject config fetches and use retained assets only.
    if (!recovering && url.origin === origin && name === "config.json") {
      await route.fallback();
      return;
    }
    if (url.origin !== origin || !files.has(name)) {
      unexpected.push(route.request().url());
      await route.abort();
      return;
    }
    if (
      recovering &&
      (name === "cpm22.img" ||
        name === "config.json" ||
        /^bootstrap.*\.bin$/.test(name) ||
        /^system-.*\.bin$/.test(name))
    ) {
      forbiddenRecovery.push(name);
      await route.abort();
      return;
    }
    if (recovering) served.add(name);
    await route.fulfill({
      contentType: types[extname(name)] ?? "application/octet-stream",
      body: await readFile(join(directory, name)),
    });
  };
  // Both phases use exact identified assets, except the initial explicit legacy
  // config fixture above. Recovery has no fallback and cannot fetch fresh media.
  const initialRoute = siteRoute(sourceDirectory, false);
  await page.route("**/*", initialRoute);
  await page.goto("/");
  await recoveryPrompt(page);
  await recoveryManage(page);
  await page.locator("#enable-ab").click();
  await expect(page.locator("#files-status")).toContainText(
    "A/B enabled in the staged set",
  );
  await page.locator("#blank-b").click();
  await expect(page.locator("#files-status")).toContainText(
    "Blank eight MiB B staged",
  );
  for (const [drive, text] of [
    ["A", "A archive sentinel\r\n"],
    ["B", "B archive sentinel\r\n"],
  ]) {
    await page.locator("#file-drive").selectOption(drive);
    await page.locator("#file-import").setInputFiles({
      name: "KEEP.TXT",
      mimeType: "text/plain",
      buffer: Buffer.from(text),
    });
    // Both drives import KEEP.TXT. Wait for this asynchronous read to finish;
    // the identical status from A cannot acknowledge the subsequent B import.
    await expect(page.locator("#file-import")).toHaveValue("");
    await expect(page.locator("#files-status")).toContainText(
      "Staged KEEP.TXT",
    );
  }
  await recoveryApply(page);
  const beforeSecondChange = await completeRecoveryState(page);
  expect(beforeSecondChange.snapshot.bootstrap.profile).toBe(
    "triptych-cpu-v0.1-8m-ab",
  );
  for (const drive of ["A", "B"])
    expect(beforeSecondChange.snapshot.drives[drive].length).toBe(8388608);
  expect(beforeSecondChange.snapshot.drives.A.sha256).not.toBe(
    beforeSecondChange.snapshot.drives.B.sha256,
  );
  await recoveryManage(page);
  await page.locator("#file-drive").selectOption("B");
  await page.locator("#file-import").setInputFiles({
    name: "AFTER.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("B after backup sentinel\r\n"),
  });
  await expect(page.locator("#files-status")).toContainText("Staged AFTER.TXT");
  await recoveryApply(page);
  const saved = await completeRecoveryState(page);
  expect(saved.snapshot.drives.A).toEqual(beforeSecondChange.snapshot.drives.A);
  expect(saved.snapshot.bootstrap).toEqual(
    beforeSecondChange.snapshot.bootstrap,
  );
  expect(saved.snapshot.drives.B.sha256).not.toBe(
    beforeSecondChange.snapshot.drives.B.sha256,
  );
  expect(saved.backups).toHaveLength(2);
  expect(saved.backups[0].snapshot).toEqual(beforeSecondChange.snapshot);
  expect(saved.backups[1].snapshot.bootstrap.profile).toBe("legacy-e400");
  const originalDownloads = await completeRecoveryDownloads(
    page,
    info,
    "before",
    saved,
  );
  // Register the new route first, so there is never a live-network window.
  await page.route("**/*", siteRoute(join(archiveDirectory, "site"), true));
  await page.unroute("**/*", initialRoute);
  await page.reload();
  await recoveryPrompt(page);
  expect(new URL(page.url()).origin).toBe(origin);
  expect(await completeRecoveryState(page)).toEqual(saved);
  for (const name of [
    "index.html",
    "app.js",
    "drive-set-store.js",
    "drive-set.js",
    "triptych_host_wasm_bg.wasm",
  ])
    expect(served.has(name), `${name} came from retained archive`).toBe(true);
  // Same filename on both drives discriminates a B request accidentally sent to A.
  await recoveryCommand(page, "TYPE KEEP.TXT", "A");
  await expect(page.locator("#terminal")).toContainText("A archive sentinel");
  await recoveryCommand(page, "B:", "A", "B");
  await recoveryCommand(page, "TYPE KEEP.TXT");
  await expect(page.locator("#terminal")).toContainText("B archive sentinel");
  await recoveryCommand(page, "TYPE AFTER.TXT");
  await expect(page.locator("#terminal")).toContainText(
    "B after backup sentinel",
  );
  const afterReads = await completeRecoveryState(page);
  expect(afterReads.snapshot).toEqual(saved.snapshot);
  expect(afterReads.backups).toEqual(saved.backups);
  const recoveredDownloads = await completeRecoveryDownloads(
    page,
    info,
    "recovered",
    saved,
  );
  // Canonical .tds equality checks every complete image, names, profile and
  // bootstrap byte, not merely directory listings or selected files.
  expect(recoveredDownloads.head).toEqual(originalDownloads.head);
  expect([...recoveredDownloads.backups.keys()]).toEqual([
    ...originalDownloads.backups.keys(),
  ]);
  for (const [id, bytes] of originalDownloads.backups)
    expect(recoveredDownloads.backups.get(id)).toEqual(bytes);
  const afterDownloads = await completeRecoveryState(page);
  expect(afterDownloads.snapshot).toEqual(saved.snapshot);
  expect(afterDownloads.backups).toEqual(saved.backups);
  expect(
    forbiddenRecovery,
    "no fresh seed/bootstrap/system fallback was attempted",
  ).toEqual([]);
  expect(
    unexpected,
    "every HTTP asset must come from the identified closed site",
  ).toEqual([]);
  await verifyBrowserRecoveryArchive(options);
});
