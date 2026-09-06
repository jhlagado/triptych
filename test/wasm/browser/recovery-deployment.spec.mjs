import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
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
