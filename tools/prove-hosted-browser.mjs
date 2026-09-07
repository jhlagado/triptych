import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";
import { decodeDriveSet } from "../crates/triptych-host-wasm/web/drive-set.js";
import { checkServedTwoMibAssets } from "./lib/served-two-mib-assets.mjs";

// The directory must be the downloaded CI artifact, not a local rebuild.
const [address, directoryArgument, revision] = process.argv.slice(2);
assert.ok(
  address && directoryArgument && revision,
  "usage: node tools/prove-hosted-browser.mjs URL CI_ARTIFACT_DIRECTORY REVISION",
);
assert.match(revision, /^[0-9a-f]{40}$/);
const base = new URL(address.endsWith("/") ? address : `${address}/`);
assert.ok(
  base.protocol === "https:" ||
    (base.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(base.hostname)),
);
const directory = resolve(directoryArgument);
execFileSync(
  process.execPath,
  [
    "tools/check-browser-deployment.mjs",
    directory,
    revision,
    "--release",
    "--require-two-mib",
  ],
  { stdio: "inherit" },
);
const expectedManifest = await readFile(
  join(directory, "deployment-manifest.json"),
);
const manifest = JSON.parse(expectedManifest);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function download(name) {
  const response = await fetch(new URL(name, base), {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
assert.deepEqual(
  await download("deployment-manifest.json"),
  expectedManifest,
  "hosted manifest differs from CI artifact",
);
for (const asset of manifest.assets) {
  const bytes = await download(asset.path);
  assert.equal(bytes.length, asset.bytes, `${asset.path} hosted length`);
  assert.equal(digest(bytes), asset.sha256, `${asset.path} hosted digest`);
}

const browser = await chromium.launch();
try {
  const errors = [];
  const responseChecks = [];
  const profiles = [];
  function observe(page, label) {
    const seen = new Set();
    profiles.push({ label, seen });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
        return;
      const name = url.pathname.slice(base.pathname.length) || "index.html";
      const asset = manifest.assets.find((entry) => entry.path === name);
      if (!asset && name !== "deployment-manifest.json") return;
      responseChecks.push(
        (async () => {
          assert.ok(
            response.ok(),
            `${label}/${name}: HTTP ${response.status()}`,
          );
          const bytes = await response.body();
          if (asset) {
            assert.equal(bytes.length, asset.bytes, `${label}/${name} length`);
            assert.equal(
              digest(bytes),
              asset.sha256,
              `${label}/${name} digest`,
            );
          } else assert.deepEqual(bytes, expectedManifest, `${label}/manifest`);
          seen.add(name);
        })().catch((error) => errors.push(error.message)),
      );
    });
    page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
    return seen;
  }
  async function newPage() {
    // Every profile is disposable; no user's browser or saved disk is opened.
    const context = await browser.newContext();
    // Playwright routing disables the HTTP cache. Each navigation must supply
    // complete response bytes for identity checks, not a conditional 304.
    // Forward requests unchanged; status, length and hash checks still apply.
    await context.route("**/*", (route) => route.continue());
    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    page.on("dialog", (dialog) => dialog.accept());
    return page;
  }
  async function lastLine(page) {
    return (await page.locator("#terminal").textContent())
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .at(-1);
  }
  async function prompt(page, drive = "A") {
    await expect
      .poll(() => lastLine(page), { timeout: 30_000 })
      .toBe(`${drive}>`);
  }
  async function boot(page, reload = false) {
    if (reload) await page.reload();
    else await page.goto(base.href);
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "running",
    );
    await prompt(page);
  }
  async function savedBoot(page) {
    const requested = [];
    const collect = (request) => {
      const url = new URL(request.url());
      if (url.origin === base.origin && url.pathname.startsWith(base.pathname))
        requested.push(url.pathname.slice(base.pathname.length));
    };
    page.on("request", collect);
    try {
      await boot(page, true);
    } finally {
      page.off("request", collect);
    }
    assert.deepEqual(
      requested.filter(
        (name) =>
          ["config.json", "cpm22.img"].includes(name) ||
          /^bootstrap.*\.bin$/.test(name) ||
          /^system-.*\.bin$/.test(name),
      ),
      [],
      "Saved v3 navigation must use retained media/bootstrap, not fresh assets",
    );
  }
  async function send(page, value, drive = "A") {
    const terminal = page.locator("#terminal");
    await prompt(page, drive);
    await terminal.focus();
    await page.keyboard.type(value);
    // Observe THIS command being echoed before Enter; an earlier identical
    // command and A> elsewhere on the 24-row screen cannot satisfy completion.
    await expect
      .poll(() => lastLine(page), { timeout: 30_000 })
      .toBe(`${drive}>${value}`);
    const entered = await terminal.textContent();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => terminal.textContent(), { timeout: 30_000 })
      .not.toBe(entered);
  }
  async function command(page, value, drive = "A", resultDrive = drive) {
    await send(page, value, drive);
    await prompt(page, resultDrive);
  }
  async function stored(page) {
    return page.evaluate(
      async ({ url, historicalBootstrap }) => {
        const { openDriveSetStore } = await import(url);
        let store = await openDriveSetStore();
        try {
          let head = await store.load();
          if (
            head.kind === "recovery" &&
            head.error ===
              "Historical bootstrap is required to reopen the saved legacy disk."
          ) {
            store.close();
            store = await openDriveSetStore({
              legacyBootstrap: Uint8Array.from(historicalBootstrap),
            });
            head = await store.load();
          }
          if (head.kind !== "ready")
            throw new Error(
              `Expected ready saved state: ${JSON.stringify(head)}`,
            );
          const backups = (await store.listBackups()).sort(
            (a, b) => b.revision - a.revision || a.id.localeCompare(b.id),
          );
          return {
            revision: head.token.revision,
            token: head.token,
            name: head.snapshot.drives.A.name,
            bytes: Array.from(head.snapshot.drives.A.bytes),
            b: head.snapshot.drives.B
              ? {
                  name: head.snapshot.drives.B.name,
                  bytes: Array.from(head.snapshot.drives.B.bytes),
                }
              : null,
            bootstrap: {
              profile: head.snapshot.bootstrap.profile,
              bytes: Array.from(head.snapshot.bootstrap.bytes),
            },
            backups: await Promise.all(
              backups.map(async (entry) => {
                const reader = entry.id.startsWith("v2:")
                  ? await openDriveSetStore({
                      legacyBootstrap: Uint8Array.from(historicalBootstrap),
                    })
                  : store;
                let backup;
                try {
                  backup = await reader.readBackup(entry.id);
                } finally {
                  if (reader !== store) reader.close();
                }
                return {
                  ...entry,
                  name: backup.drives.A.name,
                  bytes: Array.from(backup.drives.A.bytes),
                  b: backup.drives.B
                    ? {
                        name: backup.drives.B.name,
                        bytes: Array.from(backup.drives.B.bytes),
                      }
                    : null,
                  bootstrap: {
                    profile: backup.bootstrap.profile,
                    bytes: Array.from(backup.bootstrap.bytes),
                  },
                };
              }),
            ),
          };
        } finally {
          store.close();
        }
      },
      {
        url: new URL("drive-set-store.js", base).href,
        historicalBootstrap: Array.from(
          await readFile(join(directory, "bootstrap.bin")),
        ),
      },
    );
  }
  async function manage(page) {
    if (!(await page.locator("#files-dialog").isVisible()))
      await page.locator("#files").click();
    await page.locator("#saved-and-exited").check();
    await page.locator("#begin-management").click();
    // Browser file-input APIs can set files on disabled controls. Await the
    // completed acknowledged management barrier, not merely the click.
    await expect(page.locator("#disk-input")).toBeEnabled();
  }
  async function apply(page) {
    await expect(page.locator("#commit-disk")).toBeEnabled();
    await page.locator("#commit-disk").click();
    await expect(page.locator("#files-status")).toContainText("Disk committed");
  }
  async function prepare(page) {
    await page.locator("#prepare-build").click();
    await expect(page.locator("#files-status")).toContainText(
      "Staged GAME.NU, GAME.MAP",
    );
    await apply(page);
    await page.locator("#close-files").click();
    await prompt(page);
  }
  async function quitGame(page) {
    await page.keyboard.type("Q");
    await expect(page.locator("#terminal")).toContainText("Bye.");
    await prompt(page);
  }
  async function editReplacement(
    page,
    file,
    find,
    replace,
    expectedText,
    drive = "A",
  ) {
    await send(page, `EDIT ${file}`, drive);
    const terminal = page.locator("#terminal");
    await expect(terminal).toContainText("^S Save  ^Q Quit");
    await page.keyboard.press("Control+f");
    await page.keyboard.type(find);
    await page.keyboard.press("Enter");
    await page.keyboard.press("Control+r");
    await page.keyboard.type(replace);
    await page.keyboard.press("Enter");
    await expect(terminal).toContainText(expectedText);
    await page.keyboard.press("Control+s");
    await page.keyboard.press("Control+q");
    await prompt(page, drive);
  }

  const page = await newPage();
  const freshSeen = observe(page, "fresh");
  const terminal = page.locator("#terminal");
  await boot(page);
  await checkServedTwoMibAssets(page, base.href, manifest);
  await command(page, "ATOM HELLO.ASM");
  await expect(terminal).toContainText("HELLO.COM written");
  await command(page, "HELLO");
  await expect(terminal).toContainText("Hello from ATOM");
  await editReplacement(
    page,
    "INPUT.NU",
    "'O'",
    "'Y'",
    "writeOutputByte('Y') else fail",
  );
  await command(page, "NUC INPUT.NU");
  await command(page, "INPUT");
  await expect(terminal).toContainText("YK");
  await expect(page.locator("#save-status")).toHaveText(
    "Working disk saved in this browser.",
  );
  await savedBoot(page);
  await send(page, "EDIT INPUT.NU");
  await expect(terminal).toContainText("writeOutputByte('Y') else fail");
  await expect(terminal).toContainText("^S Save  ^Q Quit");
  await page.keyboard.press("Control+q");
  await prompt(page);
  await command(page, "INPUT");
  await expect(terminal).toContainText("YK");

  await manage(page);
  await page.locator("#stage-adventure").click();
  await expect(page.locator("#files-status")).toContainText(
    "Staged IO.NU, MAIN.NU, BUILD.JSN",
  );
  await prepare(page);
  await command(page, "NUC GAME.NU");
  await send(page, "GAME");
  await expect(terminal).toContainText("CAVE>");
  await page.keyboard.type("E");
  await expect(terminal).toContainText("HILL>");
  await page.keyboard.type("T");
  await expect(terminal).toContainText("You have the key");
  await page.keyboard.type("W");
  await expect(terminal).toContainText("You win!");
  await prompt(page);
  await editReplacement(page, "MAIN.NU", "CAVE", "BASE", "BASE>");
  await manage(page);
  await prepare(page);
  await command(page, "NUC GAME.NU");
  await send(page, "GAME");
  await expect(terminal).toContainText("BASE>");
  await quitGame(page);
  await manage(page);
  const beforeUpdate = await stored(page);
  await page
    .locator("#tool-list li")
    .filter({ hasText: "NUC.COM" })
    .getByRole("button")
    .click();
  await expect(page.locator("#files-status")).toContainText("Staged NUC.COM");
  await apply(page);
  const afterUpdate = await stored(page);
  for (const name of [
    "IO.NU",
    "MAIN.NU",
    "BUILD.JSN",
    "GAME.NU",
    "GAME.MAP",
    "GAME.COM",
    "ATOM.COM",
    "EDIT.COM",
    "HELLO.ASM",
    "HELLO.COM",
    "INPUT.NU",
    "INPUT.COM",
  ])
    assert.deepEqual(
      readCpm22File(Uint8Array.from(afterUpdate.bytes), name),
      readCpm22File(Uint8Array.from(beforeUpdate.bytes), name),
      `${name}: selected update preserves file`,
    );
  assert.equal(afterUpdate.backups.length, beforeUpdate.backups.length + 1);
  assert.ok(
    afterUpdate.backups.some(
      (entry) =>
        entry.revision === beforeUpdate.revision &&
        digest(Buffer.from(entry.bytes)) ===
          digest(Buffer.from(beforeUpdate.bytes)),
    ),
    "selected update retains exact preceding disk backup",
  );
  assert.deepEqual(
    readCpm22File(Uint8Array.from(afterUpdate.bytes), "NUC.COM"),
    readCpm22File(await readFile(join(directory, "cpm22.img")), "NUC.COM"),
    "installed NUC matches released padded bytes",
  );
  await page.locator("#close-files").click();
  await savedBoot(page);
  assert.deepEqual(
    await stored(page),
    afterUpdate,
    "reload preserves disk, revision and backups",
  );
  await send(page, "GAME");
  await expect(terminal).toContainText("BASE>");
  await quitGame(page);
  const pendingDownload = page.waitForEvent("download");
  await page.locator("#download").click();
  const downloaded = await pendingDownload;
  const downloadPath = await downloaded.path();
  assert.ok(downloadPath, "disk download completed");
  const downloadedBytes = await readFile(downloadPath);
  assert.deepEqual(downloadedBytes, Buffer.from(afterUpdate.bytes));

  const reopened = await newPage();
  observe(reopened, "download-reopen");
  await boot(reopened);
  await manage(reopened);
  await expect(reopened.locator("#disk-input")).toBeEnabled();
  await reopened.locator("#disk-input").setInputFiles({
    name: "adventure.img",
    mimeType: "application/octet-stream",
    buffer: downloadedBytes,
  });
  await expect(reopened.locator("#files-status")).toContainText(
    "Staged exact disk adventure.img",
  );
  await apply(reopened);
  assert.deepEqual((await stored(reopened)).bytes, afterUpdate.bytes);
  await reopened.locator("#close-files").click();
  await send(reopened, "GAME");
  await expect(reopened.locator("#terminal")).toContainText("BASE>");
  await quitGame(reopened);

  // Create only the legacy record in another disposable origin profile. Abort
  // the first app load so it cannot open/migrate the database before seeding.
  // The qualified navigation loads hosted files without response substitution.
  const migrated = await newPage();
  const appUrl = new URL("app.js", base).href;
  await migrated.route(appUrl, (route) => route.abort());
  await migrated.goto(base.href);
  const legacyBytes = installCpm22File(
    await readFile(join(directory, "cpm22.img")),
    {
      name: "KEEP.TXT",
      bytes: Buffer.from("Hosted migration keeps this file\r\n"),
      padByte: 26,
    },
  );
  await migrated.evaluate(
    (bytes) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("triptych-cpu", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("working-disks", { keyPath: "key" });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("working-disks", "readwrite");
          tx.objectStore("working-disks").put({
            schema: "triptych-working-disk-v1",
            key: "drive-a",
            name: "legacy.img",
            bytes: Uint8Array.from(bytes),
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
    Array.from(legacyBytes),
  );
  await migrated.unrouteAll();
  const migratedSeen = observe(migrated, "migrated");
  await boot(migrated, true);
  assert.deepEqual(
    (await stored(migrated)).bytes,
    Array.from(legacyBytes),
    "migration reopens exact legacy disk",
  );
  const retainedLegacy = await migrated.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("triptych-cpu");
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction("working-disks", "readonly");
          const record = tx.objectStore("working-disks").get("drive-a");
          tx.oncomplete = () => {
            const result = {
              version: db.version,
              bytes: Array.from(record.result.bytes),
            };
            db.close();
            resolve(result);
          };
          tx.onabort = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  assert.deepEqual(
    retainedLegacy,
    { version: 3, bytes: Array.from(legacyBytes) },
    "version 3 preserves legacy record",
  );
  await command(migrated, "TYPE KEEP.TXT");
  await expect(migrated.locator("#terminal")).toContainText(
    "Hosted migration keeps this file",
  );
  await manage(migrated);
  await migrated.locator("#file-import").setInputFiles({
    name: "AFTER.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("Written after hosted migration\r\n"),
  });
  await expect(migrated.locator("#files-status")).toContainText(
    "Staged AFTER.TXT",
  );
  await apply(migrated);
  const migratedSaved = await stored(migrated);
  assert.equal(migratedSaved.backups.length, 1);
  assert.deepEqual(migratedSaved.backups[0].bytes, Array.from(legacyBytes));
  await migrated.locator("#close-files").click();
  await savedBoot(migrated);
  assert.deepEqual(
    await stored(migrated),
    migratedSaved,
    "migrated head and backup survive reload",
  );
  await command(migrated, "TYPE AFTER.TXT");
  await expect(migrated.locator("#terminal")).toContainText(
    "Written after hosted migration",
  );

  // Seed a genuine historical v2 head/change through its published API, then
  // verify the v3 adapter does not rewrite either original record.
  const migratedV2 = await newPage();
  await migratedV2.route(appUrl, (route) => route.abort());
  await migratedV2.goto(base.href);
  const v2HeadBytes = installCpm22File(legacyBytes, {
    name: "V2.TXT",
    bytes: Buffer.from("Historical revision two\r\n"),
    padByte: 26,
  });
  const legacyStoreUrl = new URL("working-disk-revisions.js", base).href;
  // This module executes while the new app is intentionally blocked. Bind its
  // actual browser response, not only the separate all-assets HTTP download.
  const seedResponsePending = migratedV2.waitForResponse(
    (response) => response.url() === legacyStoreUrl,
  );
  await migratedV2.evaluate(
    async ({ url, before, after }) => {
      const { openRevisionedDiskStore } = await import(url);
      const store = await openRevisionedDiskStore();
      try {
        await store.saveCheckpoint(0, {
          name: "historical-v2.img",
          bytes: Uint8Array.from(before),
        });
        await store.commitChange(1, "hosted-v2-change", {
          name: "historical-v2.img",
          bytes: Uint8Array.from(after),
        });
      } finally {
        store.close();
      }
    },
    {
      url: legacyStoreUrl,
      before: Array.from(legacyBytes),
      after: Array.from(v2HeadBytes),
    },
  );
  const seedResponse = await seedResponsePending;
  const seedBytes = await seedResponse.body();
  const seedAsset = manifest.assets.find(
    (asset) => asset.path === "working-disk-revisions.js",
  );
  assert.ok(seedResponse.ok(), "historical store module response succeeded");
  assert.ok(seedAsset, "historical store module is in the verified manifest");
  assert.equal(seedBytes.length, seedAsset.bytes);
  assert.equal(digest(seedBytes), seedAsset.sha256);
  async function rawLegacyV2(target) {
    return target.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const opening = indexedDB.open("triptych-cpu");
          opening.onerror = () => reject(opening.error);
          opening.onsuccess = () => {
            const db = opening.result;
            const tx = db.transaction(
              ["working-disks", "disk-revisions"],
              "readonly",
            );
            const v1 = tx.objectStore("working-disks").getAll();
            const v2 = tx.objectStore("disk-revisions").getAll();
            tx.onabort = () => {
              db.close();
              reject(tx.error);
            };
            tx.oncomplete = () => {
              db.close();
              resolve(
                JSON.parse(
                  JSON.stringify(
                    { v1: v1.result, v2: v2.result },
                    (_key, value) =>
                      value instanceof Uint8Array ? Array.from(value) : value,
                  ),
                ),
              );
            };
          };
        }),
    );
  }
  const v2RawBefore = await rawLegacyV2(migratedV2);
  await migratedV2.unrouteAll();
  const migratedV2Seen = observe(migratedV2, "migrated-v2");
  await boot(migratedV2, true);
  const v2Reopened = await stored(migratedV2);
  assert.deepEqual(v2Reopened.bytes, Array.from(v2HeadBytes));
  assert.equal(v2Reopened.backups.length, 1);
  assert.equal(v2Reopened.backups[0].id, "v2:hosted-v2-change");
  assert.deepEqual(v2Reopened.backups[0].bytes, Array.from(legacyBytes));
  assert.deepEqual(await rawLegacyV2(migratedV2), v2RawBefore);
  await command(migratedV2, "TYPE V2.TXT");
  await expect(migratedV2.locator("#terminal")).toContainText(
    "Historical revision two",
  );
  await manage(migratedV2);
  await expect(migratedV2.locator("#file-import")).toBeEnabled();
  await migratedV2.locator("#file-import").setInputFiles({
    name: "AFTER.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("Written after v2 migration\r\n"),
  });
  await expect(migratedV2.locator("#files-status")).toContainText(
    "Staged AFTER.TXT",
  );
  await apply(migratedV2);
  const v2Saved = await stored(migratedV2);
  assert.equal(v2Saved.backups.length, 2);
  assert.deepEqual(
    v2Saved.backups.find((b) => b.id.startsWith("v3:")).bytes,
    Array.from(v2HeadBytes),
  );
  assert.deepEqual(
    v2Saved.backups.find((b) => b.id === "v2:hosted-v2-change").bytes,
    Array.from(legacyBytes),
  );
  assert.deepEqual(await rawLegacyV2(migratedV2), v2RawBefore);
  await migratedV2.locator("#close-files").click();
  await savedBoot(migratedV2);
  assert.deepEqual(await stored(migratedV2), v2Saved);
  assert.deepEqual(await rawLegacyV2(migratedV2), v2RawBefore);
  await command(migratedV2, "TYPE AFTER.TXT");
  await expect(migratedV2.locator("#terminal")).toContainText(
    "Written after v2 migration",
  );

  // A separate disposable context exercises the actual hosted A/B assets and
  // selected-drive UI. Hash complete images without serializing every backup's
  // 16 MiB payload through the browser automation protocol.
  async function setState(page) {
    return page.evaluate(
      async ({ storeUrl, wasmUrl }) => {
        const { openDriveSetStore } = await import(storeUrl);
        const { CpmDisk } = await import(wasmUrl);
        const hash = async (bytes) =>
          Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (v) => v.toString(16).padStart(2, "0"),
          ).join("");
        const describe = async (snapshot) => {
          const drives = {};
          for (const name of ["A", "B"]) {
            const image = snapshot.drives[name];
            if (!image) {
              drives[name] = null;
              continue;
            }
            const disk = new CpmDisk(image.bytes);
            try {
              const files = {};
              for (const name of disk.file_names())
                files[name] = await hash(disk.read_file(name));
              drives[name] = {
                name: image.name,
                bytes: image.bytes.length,
                sha256: await hash(image.bytes),
                systemSha256: await hash(
                  image.bytes.subarray(
                    0,
                    disk.geometry_id() === "ibm3740" ? 6656 : 16384,
                  ),
                ),
                files,
              };
            } finally {
              disk.free();
            }
          }
          return {
            bootstrap: {
              profile: snapshot.bootstrap.profile,
              sha256: await hash(snapshot.bootstrap.bytes),
            },
            drives,
          };
        };
        const store = await openDriveSetStore();
        try {
          const head = await store.load();
          if (head.kind !== "ready") throw new Error(JSON.stringify(head));
          const backups = [];
          for (const entry of (await store.listBackups()).sort(
            (a, b) => b.revision - a.revision || a.id.localeCompare(b.id),
          )) {
            if (entry.kind !== "available")
              throw new Error(JSON.stringify(entry));
            const backup = await store.readBackup(entry.id);
            if (!backup) throw new Error(`Missing backup ${entry.id}`);
            backups.push({ ...entry, ...(await describe(backup)) });
          }
          return {
            token: head.token,
            ...(await describe(head.snapshot)),
            backups,
          };
        } finally {
          store.close();
        }
      },
      {
        storeUrl: new URL("drive-set-store.js", base).href,
        wasmUrl: new URL("triptych_host_wasm.js", base).href,
      },
    );
  }
  const media = (value) => ({
    bootstrap: value.bootstrap,
    drives: value.drives,
  });
  function exactPrecedingBackup(before, after, label) {
    assert.equal(
      after.backups.length,
      before.backups.length + 1,
      `${label}: exactly one complete backup`,
    );
    const backup = after.backups.find(
      (entry) => entry.revision === before.token.revision,
    );
    assert.ok(backup, `${label}: preceding revision retained`);
    assert.deepEqual(
      media(backup),
      media(before),
      `${label}: both images and bootstrap retained`,
    );
  }
  async function archiveDownload(page, selector) {
    const pending = page.waitForEvent("download");
    await page.locator(selector).click();
    const path = await (await pending).path();
    assert.ok(path, "complete-set archive download finished");
    return readFile(path);
  }
  function checkArchive(snapshot, expected) {
    assert.equal(snapshot.bootstrap.profile, expected.bootstrap.profile);
    assert.equal(digest(snapshot.bootstrap.bytes), expected.bootstrap.sha256);
    for (const name of ["A", "B"]) {
      if (expected.drives[name] === null) {
        assert.equal(snapshot.drives[name], null);
        continue;
      }
      assert.equal(snapshot.drives[name].name, expected.drives[name].name);
      assert.equal(
        snapshot.drives[name].bytes.length,
        expected.drives[name].bytes,
      );
      assert.equal(
        digest(snapshot.drives[name].bytes),
        expected.drives[name].sha256,
      );
    }
  }
  const ab = await newPage();
  const abSeen = observe(ab, "eight-mib-ab");
  await boot(ab);
  await manage(ab);
  const beforeAb = await setState(ab);
  await expect(ab.locator("#enable-ab")).toBeEnabled();
  await ab.locator("#enable-ab").click();
  await expect(ab.locator("#files-status")).toContainText(
    "A/B enabled in the staged set",
  );
  await ab.locator("#blank-b").click();
  await expect(ab.locator("#files-status")).toContainText(
    "Blank eight MiB B staged",
  );
  assert.deepEqual(
    await setState(ab),
    beforeAb,
    "A/B staging leaves saved state exact",
  );
  await apply(ab);
  await prompt(ab);
  const initialAb = await setState(ab);
  assert.equal(initialAb.bootstrap.profile, "triptych-cpu-v0.1-8m-ab");
  assert.equal(
    initialAb.bootstrap.sha256,
    manifest.diskProfiles.find(
      (p) => p.residentProfile === "triptych-cpu-v0.1-8m-ab",
    ).bootstrapSha256,
  );
  assert.equal(initialAb.drives.A.bytes, 8388608);
  assert.equal(initialAb.drives.B.bytes, 8388608);
  assert.deepEqual(initialAb.drives.A.files, beforeAb.drives.A.files);
  assert.deepEqual(initialAb.drives.B.files, {});
  assert.equal(initialAb.drives.B.systemSha256, digest(Buffer.alloc(16384)));
  exactPrecedingBackup(beforeAb, initialAb, "enable A/B");

  await manage(ab);
  const beforeInstall = await setState(ab);
  await ab.locator("#file-drive").selectOption("B");
  await expect(ab.locator("#disk-summary")).toContainText("Drive B:");
  const defaultImage = await readFile(join(directory, "cpm22.img"));
  await ab.locator("#file-import").setInputFiles([
    ...["HELLO.ASM", "INPUT.NU"].map((name) => ({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(readCpm22File(defaultImage, name)),
    })),
    {
      name: "NOTE.TXT",
      mimeType: "text/plain",
      buffer: Buffer.from("Hosted B note\r\n"),
    },
  ]);
  await expect(ab.locator("#files-status")).toContainText(
    "Staged HELLO.ASM, INPUT.NU, NOTE.TXT",
  );
  for (const name of ["ATOM.COM", "NUC.COM", "EDIT.COM"]) {
    await ab
      .locator("#tool-list li")
      .filter({ hasText: name })
      .getByRole("button")
      .click();
    await expect(ab.locator("#files-status")).toContainText(`Staged ${name}`);
  }
  assert.deepEqual(
    await setState(ab),
    beforeInstall,
    "B imports/tools are staged only",
  );
  await apply(ab);
  await prompt(ab);
  const installedAb = await setState(ab);
  assert.deepEqual(installedAb.drives.A, initialAb.drives.A);
  assert.deepEqual(installedAb.bootstrap, initialAb.bootstrap);
  assert.equal(
    installedAb.drives.B.systemSha256,
    initialAb.drives.B.systemSha256,
  );
  for (const name of [
    "ATOM.COM",
    "NUC.COM",
    "EDIT.COM",
    "HELLO.ASM",
    "INPUT.NU",
  ])
    assert.equal(
      installedAb.drives.B.files[name],
      digest(readCpm22File(defaultImage, name)),
      `${name}: exact released B file`,
    );
  exactPrecedingBackup(beforeInstall, installedAb, "B files/tools");
  await ab.locator("#close-files").click();
  await command(ab, "B:", "A", "B");
  await command(ab, "TYPE NOTE.TXT", "B");
  await expect(ab.locator("#terminal")).toContainText("Hosted B note");
  await command(ab, "ATOM HELLO.ASM", "B");
  await expect(ab.locator("#terminal")).toContainText("HELLO.COM written");
  await command(ab, "HELLO", "B");
  await expect(ab.locator("#terminal")).toContainText("Hello from ATOM");
  await editReplacement(
    ab,
    "INPUT.NU",
    "'O'",
    "'Y'",
    "writeOutputByte('Y') else fail",
    "B",
  );
  await command(ab, "NUC INPUT.NU", "B");
  await command(ab, "INPUT", "B");
  await expect(ab.locator("#terminal")).toContainText("YK");
  await manage(ab);
  const workedAb = await setState(ab);
  assert.deepEqual(workedAb.drives.A, installedAb.drives.A);
  assert.deepEqual(workedAb.bootstrap, installedAb.bootstrap);
  assert.equal(
    workedAb.drives.B.systemSha256,
    installedAb.drives.B.systemSha256,
  );
  assert.notEqual(
    workedAb.drives.B.files["INPUT.NU"],
    installedAb.drives.B.files["INPUT.NU"],
  );
  assert.ok(
    workedAb.drives.B.files["HELLO.COM"] &&
      workedAb.drives.B.files["INPUT.COM"],
  );
  await ab.locator("#cancel-management").click();
  await ab.locator("#close-files").click();
  await savedBoot(ab);
  assert.deepEqual(
    media(await setState(ab)),
    media(workedAb),
    "A/B saved reload preserves complete media",
  );
  await command(ab, "B:", "A", "B");
  await command(ab, "INPUT", "B");
  await expect(ab.locator("#terminal")).toContainText("YK");
  const abArchiveBytes = await archiveDownload(ab, "#download-set");
  checkArchive(await decodeDriveSet(abArchiveBytes), workedAb);
  await manage(ab);
  const beforeRemove = await setState(ab);
  await ab.locator("#remove-b").click();
  assert.deepEqual(
    await setState(ab),
    beforeRemove,
    "B removal remains staged",
  );
  await apply(ab);
  await prompt(ab);
  const removedAb = await setState(ab);
  assert.equal(removedAb.drives.B, null);
  assert.deepEqual(removedAb.drives.A, workedAb.drives.A);
  assert.deepEqual(removedAb.bootstrap, workedAb.bootstrap);
  exactPrecedingBackup(beforeRemove, removedAb, "remove B");
  await manage(ab);
  const backupId = removedAb.backups.find(
    (entry) => entry.revision === beforeRemove.token.revision,
  ).id;
  const backupRow = ab.locator("#backup-list li").filter({ hasText: backupId });
  const backupDownload = ab.waitForEvent("download");
  await backupRow
    .getByRole("button", { name: "Download set", exact: true })
    .click();
  const backupPath = await (await backupDownload).path();
  assert.ok(backupPath, "complete backup download finished");
  checkArchive(await decodeDriveSet(await readFile(backupPath)), workedAb);
  const beforeBackupRestore = await setState(ab);
  await backupRow.locator("[data-restore]").click();
  await expect(ab.locator("#files-status")).toHaveText(
    `Backup revision ${beforeRemove.token.revision} staged. Apply and restart to restore the complete drive set.`,
  );
  assert.deepEqual(
    await setState(ab),
    beforeBackupRestore,
    "Backup restoration remains staged",
  );
  await apply(ab);
  await prompt(ab);
  const backupRestoredAb = await setState(ab);
  assert.deepEqual(media(backupRestoredAb), media(workedAb));
  exactPrecedingBackup(beforeBackupRestore, backupRestoredAb, "restore backup");
  await manage(ab);
  const beforeSecondRemove = await setState(ab);
  await ab.locator("#remove-b").click();
  await apply(ab);
  await prompt(ab);
  const secondRemovedAb = await setState(ab);
  assert.deepEqual(media(secondRemovedAb), media(removedAb));
  exactPrecedingBackup(
    beforeSecondRemove,
    secondRemovedAb,
    "remove restored B",
  );
  await manage(ab);
  const beforeRestore = await setState(ab);
  await ab.locator("#drive-set-input").setInputFiles({
    name: "both-drives.tds",
    mimeType: "application/octet-stream",
    buffer: abArchiveBytes,
  });
  await expect(ab.locator("#files-status")).toContainText(
    "Complete drive set staged",
  );
  assert.deepEqual(
    await setState(ab),
    beforeRestore,
    "Complete archive restore remains staged",
  );
  await apply(ab);
  await prompt(ab);
  const restoredAb = await setState(ab);
  assert.deepEqual(
    media(restoredAb),
    media(workedAb),
    "Archive restores both drives and exact bootstrap",
  );
  exactPrecedingBackup(beforeRestore, restoredAb, "restore A/B archive");
  await ab.locator("#close-files").click();
  await savedBoot(ab);
  assert.deepEqual(media(await setState(ab)), media(workedAb));
  await command(ab, "B:", "A", "B");
  await command(ab, "INPUT", "B");
  await expect(ab.locator("#terminal")).toContainText("YK");

  const abReopened = await newPage();
  observe(abReopened, "ab-archive-reopen");
  await boot(abReopened);
  await manage(abReopened);
  const beforeSeparateImport = await setState(abReopened);
  await abReopened.locator("#drive-set-input").setInputFiles({
    name: "reopened-drives.tds",
    mimeType: "application/octet-stream",
    buffer: abArchiveBytes,
  });
  await expect(abReopened.locator("#files-status")).toContainText(
    "Complete drive set staged",
  );
  assert.deepEqual(await setState(abReopened), beforeSeparateImport);
  await apply(abReopened);
  await prompt(abReopened);
  const separateImported = await setState(abReopened);
  assert.deepEqual(media(separateImported), media(workedAb));
  exactPrecedingBackup(
    beforeSeparateImport,
    separateImported,
    "separate archive import",
  );
  await abReopened.locator("#close-files").click();
  await savedBoot(abReopened);
  assert.deepEqual(media(await setState(abReopened)), media(workedAb));
  await command(abReopened, "B:", "A", "B");
  await command(abReopened, "INPUT", "B");
  await expect(abReopened.locator("#terminal")).toContainText("YK");

  for (const { label, seen } of profiles)
    for (const name of [
      "index.html",
      "app.js",
      "triptych_host_wasm.js",
      "triptych_host_wasm_bg.wasm",
      "drive-set-store.js",
      "drive-set.js",
      "disk-workspace.js",
      "source-bundle.js",
      "deployment-manifest.json",
    ])
      await expect
        .poll(() => seen.has(name), {
          timeout: 30_000,
          message: `${label}: browser did not load verified ${name}`,
        })
        .toBe(true);
  // Response-body verification is asynchronous. Required loads above must
  // have completed before collecting the final execution/identity verdict.
  await Promise.all(responseChecks);
  assert.ok(
    freshSeen.has("cpm22.img"),
    "fresh profile loads verified distribution",
  );
  for (const name of ["config.json", "bootstrap.bin"])
    assert.ok(freshSeen.has(name), `fresh profile loads verified ${name}`);
  for (const name of [
    "two-mib-system.js",
    "drive-set-v4.js",
    ...manifest.twoMibProfiles
      .filter((profile) => [1, 16].includes(profile.configuredCount))
      .flatMap((profile) => [profile.system.asset, profile.bootstrap.asset]),
  ])
    assert.ok(freshSeen.has(name), `browser consumed verified ${name}`);
  assert.ok(
    migratedSeen.has("bootstrap.bin"),
    "legacy profile loads its verified historical bootstrap",
  );
  assert.ok(
    migratedV2Seen.has("bootstrap.bin"),
    "v2 uses verified historical bootstrap",
  );
  assert.ok(
    !migratedV2Seen.has("cpm22.img"),
    "v2 must not replace saved media with fresh distribution",
  );
  for (const name of [
    "system-triptych-cpm-8m-ab-v1.bin",
    "bootstrap-triptych-cpm-8m-ab-v1.bin",
  ])
    assert.ok(abSeen.has(name), `A/B UI consumed verified ${name}`);
  for (const name of [
    "adventure-IO.NU",
    "adventure-MAIN.NU",
    "adventure-BUILD.JSN",
  ])
    assert.ok(freshSeen.has(name), `browser did not load verified ${name}`);
  assert.ok(
    !migratedSeen.has("cpm22.img"),
    "migrated profile must not seed over user disk",
  );
  assert.deepEqual(errors, [], "browser execution or asset identity errors");
  console.log(
    JSON.stringify({
      status: "passed",
      url: base.href,
      revision,
      assets: manifest.assets.length,
      diskSha256: manifest.distribution.disk.sha256,
      profiles: profiles.map(({ label }) => label),
      workflows: [
        "ATOM/run, Edit/NUC/run/save/reload/reopen/run",
        "Files/starter/prepare/compile/win/Edit/rebuild/selected-NUC-update/reload/download/separate-profile-reopen",
        "unmodified hosted app: v1 migration/exact legacy retention/backed-up import/reload/read",
        "hosted A/B migration/blank B/selected B import/tools/ATOM/Edit/NUC/save/reload/full archive/remove B/restore/reload/run with complete backups",
      ],
      adventureDiskSha256: digest(downloadedBytes),
      migratedDiskSha256: digest(Buffer.from(migratedSaved.bytes)),
      migratedBackupSha256: digest(Buffer.from(migratedSaved.backups[0].bytes)),
      abArchiveSha256: digest(abArchiveBytes),
      abMedia: media(workedAb),
    }),
  );
} finally {
  await browser.close();
}
