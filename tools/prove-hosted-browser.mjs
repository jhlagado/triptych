import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";

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
  ["tools/check-browser-deployment.mjs", directory, revision, "--release"],
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
  async function prompt(page) {
    await expect.poll(() => lastLine(page), { timeout: 30_000 }).toBe("A>");
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
  async function send(page, value) {
    const terminal = page.locator("#terminal");
    await prompt(page);
    await terminal.focus();
    await page.keyboard.type(value);
    // Observe THIS command being echoed before Enter; an earlier identical
    // command and A> elsewhere on the 24-row screen cannot satisfy completion.
    await expect
      .poll(() => lastLine(page), { timeout: 30_000 })
      .toBe(`A>${value}`);
    const entered = await terminal.textContent();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => terminal.textContent(), { timeout: 30_000 })
      .not.toBe(entered);
  }
  async function command(page, value) {
    await send(page, value);
    await prompt(page);
  }
  async function stored(page) {
    return page.evaluate(async (url) => {
      const { openRevisionedDiskStore } = await import(url);
      const store = await openRevisionedDiskStore();
      try {
        const head = await store.load();
        const backups = await store.listBackups();
        return {
          revision: head.revision,
          bytes: Array.from(head.bytes),
          backups: await Promise.all(
            backups.map(async (entry) => {
              const backup = await store.readBackup(entry.operationId);
              return { ...entry, bytes: Array.from(backup.bytes) };
            }),
          ),
        };
      } finally {
        store.close();
      }
    }, new URL("working-disk-revisions.js", base).href);
  }
  async function manage(page) {
    await page.locator("#files").click();
    await page.locator("#saved-and-exited").check();
    await page.locator("#begin-management").click();
    // Browser file-input APIs can set files on disabled controls. Await the
    // completed acknowledged management barrier, not merely the click.
    await expect(page.locator("#file-import")).toBeEnabled();
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
  async function editReplacement(page, file, find, replace, expectedText) {
    await send(page, `EDIT ${file}`);
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
    await prompt(page);
  }

  const page = await newPage();
  const freshSeen = observe(page, "fresh");
  const terminal = page.locator("#terminal");
  await boot(page);
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
  await boot(page, true);
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
  await boot(page, true);
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
  // The qualified navigation then loads untouched hosted files with no routes.
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
    { version: 2, bytes: Array.from(legacyBytes) },
    "version 2 preserves legacy record",
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
  await boot(migrated, true);
  assert.deepEqual(
    await stored(migrated),
    migratedSaved,
    "migrated head and backup survive reload",
  );
  await command(migrated, "TYPE AFTER.TXT");
  await expect(migrated.locator("#terminal")).toContainText(
    "Written after hosted migration",
  );
  for (const { label, seen } of profiles)
    for (const name of [
      "index.html",
      "app.js",
      "triptych_host_wasm.js",
      "triptych_host_wasm_bg.wasm",
      "config.json",
      "bootstrap.bin",
      "working-disk-revisions.js",
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
      ],
      adventureDiskSha256: digest(downloadedBytes),
      migratedDiskSha256: digest(Buffer.from(migratedSaved.bytes)),
      migratedBackupSha256: digest(Buffer.from(migratedSaved.backups[0].bytes)),
    }),
  );
} finally {
  await browser.close();
}
