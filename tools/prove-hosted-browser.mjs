import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";
import { decodeDriveSet } from "../crates/triptych-host-wasm/web/drive-set.js";
import { decodeSavedMachineArchive } from "../crates/triptych-host-wasm/web/saved-machine.js";
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
assert.equal(
  manifest.storageSchema,
  "triptych-drive-set-v4",
  "this active-app proof requires declared v4 durable authority",
);
const publicDrives = manifest.publicDrives;
assert.equal(publicDrives.schema, "triptych-public-drives-v1");
assert.equal(publicDrives.profile, "triptych-cpu-v0.1-8m-ab");
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
    const context = await browser.newContext({ serviceWorkers: "block" });
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
          [
            "config.json",
            "cpm22.img",
            "ccp.bin",
            "bdos.bin",
            "bios.bin",
            ...Object.values(publicDrives.drives).map((drive) => drive.path),
          ].includes(name) ||
          /^bootstrap.*\.bin$/.test(name) ||
          /^system-.*\.bin$/.test(name),
      ),
      [],
      "Saved navigation must use retained media/bootstrap, not fresh assets",
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
        const { openSavedMachineStore } = await import(url);
        let store = await openSavedMachineStore();
        try {
          let head = await store.load();
          if (
            head.kind === "recovery" &&
            head.code === "HISTORICAL_BOOTSTRAP_REQUIRED"
          ) {
            store.close();
            store = await openSavedMachineStore({
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
                  ? await openSavedMachineStore({
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
        url: new URL("saved-machine-store.js", base).href,
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

  const media = (value) => ({
    bootstrap: value.bootstrap,
    drives: value.drives,
  });
  const page = await newPage();
  const freshSeen = observe(page, "fresh");
  const terminal = page.locator("#terminal");
  await boot(page);
  assert.equal(
    (await stored(page)).token.kind,
    "v4",
    "fresh publication uses v4 authority",
  );
  await checkServedTwoMibAssets(page, base.href, manifest);
  const supplied = await setState(page);
  assert.equal(supplied.bootstrap.profile, publicDrives.profile);
  assert.equal(
    supplied.bootstrap.sha256,
    manifest.assets.find((asset) => asset.path === publicDrives.bootstrapAsset)
      .sha256,
  );
  for (const letter of ["A", "B"]) {
    const expected = publicDrives.drives[letter];
    assert.equal(supplied.drives[letter].bytes, expected.bytes);
    assert.equal(supplied.drives[letter].sha256, expected.sha256);
    assert.equal(supplied.drives[letter].name, expected.name);
  }
  for (const name of ["ATOM.COM", "NUC.COM", "EDIT.COM"])
    assert.ok(supplied.drives.A.files[name], `${name}: supplied on A`);
  assert.deepEqual(Object.keys(supplied.drives.B.files).sort(), [
    "CAVERNS.COM",
    "HYPERD2.COM",
    "HYPERDRV.COM",
    "README.TXT",
  ]);
  for (const name of ["CAVERNS.COM", "HYPERDRV.COM", "HYPERD2.COM"])
    assert.equal(
      supplied.drives.A.files[name],
      undefined,
      `${name}: belongs on B`,
    );

  async function gamePrompt(suffix) {
    await expect
      .poll(
        async () => (await terminal.textContent()).trimEnd().endsWith(suffix),
        { timeout: 30_000 },
      )
      .toBe(true);
  }
  async function gameCommand(value) {
    await terminal.focus();
    await page.keyboard.type(value);
    const entered = await terminal.textContent();
    await page.keyboard.press("Enter");
    await expect
      .poll(() => terminal.textContent(), { timeout: 30_000 })
      .not.toBe(entered);
  }
  async function playSuppliedGames(action) {
    await command(page, "B:", "A", "B");
    for (const game of ["CAVERNS", "HYPERDRV", "HYPERD2"]) {
      await send(page, game, "B");
      if (["CAVERNS", "HYPERD2"].includes(game)) {
        await gamePrompt("[Space/Enter: more, Q: skip]");
        await page.keyboard.type("q");
      }
      await gamePrompt("?");
      await gameCommand(action);
      await expect(terminal).toContainText(
        action === "SAVE" ? "Game saved" : "Game loaded",
      );
      await gamePrompt("?");
      await gameCommand("QUIT");
      await gamePrompt(
        game === "CAVERNS"
          ? "Another adventure?"
          : game === "HYPERDRV"
            ? "Return to CP/M? (Y/N)"
            : "any other key=cancel:",
      );
      await gameCommand(game === "CAVERNS" ? "N" : "Y");
      await prompt(page, "B");
    }
    await command(page, "A:", "B", "A");
  }
  await playSuppliedGames("SAVE");
  await expect
    .poll(async () => Object.keys((await setState(page)).drives.B.files))
    .toEqual(
      expect.arrayContaining(["CAVERNS.SAV", "HYPERDRV.SAV", "HYPERD2.SAV"]),
    );
  const gamesSaved = await setState(page);
  assert.deepEqual(
    gamesSaved.drives.A,
    supplied.drives.A,
    "B game saves leave A exact",
  );
  await savedBoot(page);
  assert.deepEqual(
    media(await setState(page)),
    media(gamesSaved),
    "both game saves survive reload without reseeding",
  );
  await playSuppliedGames("LOAD");
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
  const beforeUpdate = await setState(page);
  await page
    .locator("#tool-list li")
    .filter({ hasText: "NUC.COM" })
    .getByRole("button")
    .click();
  await expect(page.locator("#files-status")).toContainText("Staged NUC.COM");
  await apply(page);
  const afterUpdate = await setState(page);
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
  ]) {
    assert.ok(
      beforeUpdate.drives.A.files[name],
      `${name}: source file exists before update`,
    );
    assert.deepEqual(
      afterUpdate.drives.A.files[name],
      beforeUpdate.drives.A.files[name],
      `${name}: selected update preserves file`,
    );
  }
  exactPrecedingBackup(beforeUpdate, afterUpdate, "selected NUC update");
  assert.deepEqual(
    afterUpdate.drives.B,
    gamesSaved.drives.B,
    "A development and updates preserve B games and saves",
  );
  assert.deepEqual(
    afterUpdate.drives.A.files["NUC.COM"],
    supplied.drives.A.files["NUC.COM"],
    "installed NUC matches released padded bytes",
  );
  await page.locator("#close-files").click();
  await savedBoot(page);
  assert.deepEqual(
    await setState(page),
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
  assert.equal(digest(downloadedBytes), afterUpdate.drives.A.sha256);
  assert.equal(downloadedBytes.length, afterUpdate.drives.A.bytes);

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
  assert.equal(
    (await setState(reopened)).drives.A.sha256,
    afterUpdate.drives.A.sha256,
  );
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
    { version: 4, bytes: Array.from(legacyBytes) },
    "version 4 preserves the original legacy record",
  );
  await command(migrated, "TYPE KEEP.TXT");
  await expect(migrated.locator("#terminal")).toContainText(
    "Hosted migration keeps this file",
  );
  await manage(migrated);
  const migratedCheckpoint = await stored(migrated);
  assert.equal(migratedCheckpoint.backups.length, 1);
  assert.match(migratedCheckpoint.backups[0].operationId, /^checkpoint:/);
  assert.deepEqual(
    migratedCheckpoint.backups[0].bytes,
    Array.from(legacyBytes),
  );
  assert.deepEqual(
    migratedCheckpoint.backups[0].bootstrap,
    migratedCheckpoint.bootstrap,
  );
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
  assert.equal(migratedSaved.backups.length, 2);
  assert.deepEqual(migratedSaved.backups[1], migratedCheckpoint.backups[0]);
  assert.deepEqual(migratedSaved.backups[0].bytes, migratedCheckpoint.bytes);
  assert.deepEqual(
    migratedSaved.backups[0].bootstrap,
    migratedCheckpoint.bootstrap,
  );
  assert.equal(migratedSaved.backups[0].revision, migratedCheckpoint.revision);
  assert.doesNotMatch(migratedSaved.backups[0].operationId, /^checkpoint:/);
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
  // verify the v4 authority adapter does not rewrite either original record.
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
  const v2Checkpoint = await stored(migratedV2);
  assert.equal(v2Checkpoint.backups.length, 2);
  const promotedV2 = v2Checkpoint.backups.find((backup) =>
    backup.id.startsWith("v4:"),
  );
  assert.match(promotedV2.operationId, /^checkpoint:/);
  assert.deepEqual(promotedV2.bytes, Array.from(v2HeadBytes));
  assert.deepEqual(promotedV2.bootstrap, v2Checkpoint.bootstrap);
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
  assert.equal(v2Saved.backups.length, 3);
  for (const backup of v2Checkpoint.backups)
    assert.deepEqual(
      v2Saved.backups.find((entry) => entry.id === backup.id),
      backup,
    );
  const manualV2 = v2Saved.backups.find(
    (entry) => !v2Checkpoint.backups.some((backup) => backup.id === entry.id),
  );
  assert.deepEqual(manualV2.bytes, v2Checkpoint.bytes);
  assert.deepEqual(manualV2.bootstrap, v2Checkpoint.bootstrap);
  assert.equal(manualV2.revision, v2Checkpoint.revision);
  assert.doesNotMatch(manualV2.operationId, /^checkpoint:/);
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

  // A canonical v3 snapshot inside v4 storage does not exercise promotion from
  // actual v3 authority. Seed its old store while the current app is blocked.
  const migratedV3 = await newPage();
  await migratedV3.route(appUrl, (route) => route.abort());
  await migratedV3.goto(base.href);
  const v3Bootstrap = await readFile(join(directory, "bootstrap.bin"));
  const v3HeadBytes = installCpm22File(legacyBytes, {
    name: "V3.TXT",
    bytes: Buffer.from("Historical version three survives\r\n"),
    padByte: 26,
  });
  const v3StoreUrl = new URL("drive-set-store.js", base).href;
  const v3SeedResponsePending = migratedV3.waitForResponse(
    (response) => response.url() === v3StoreUrl,
  );
  await migratedV3.evaluate(
    async ({ url, bootstrap, before, after }) => {
      const { openDriveSetStore } = await import(url);
      const snapshot = (bytes) => ({
        bootstrap: {
          profile: "legacy-e400",
          bytes: Uint8Array.from(bootstrap),
        },
        drives: {
          A: { name: "historical-v3.img", bytes: Uint8Array.from(bytes) },
          B: null,
        },
      });
      const store = await openDriveSetStore();
      try {
        const first = await store.saveCheckpoint(
          { kind: "empty" },
          snapshot(before),
        );
        await store.commitChange(
          { kind: "v3", revision: first.revision },
          "hosted-v3-change",
          snapshot(after),
        );
      } finally {
        store.close();
      }
    },
    {
      url: v3StoreUrl,
      bootstrap: Array.from(v3Bootstrap),
      before: Array.from(legacyBytes),
      after: Array.from(v3HeadBytes),
    },
  );
  const v3SeedResponse = await v3SeedResponsePending;
  const v3SeedAsset = manifest.assets.find(
    (asset) => asset.path === "drive-set-store.js",
  );
  const v3SeedBody = await v3SeedResponse.body();
  assert.ok(v3SeedResponse.ok() && v3SeedAsset);
  assert.equal(v3SeedBody.length, v3SeedAsset.bytes);
  assert.equal(digest(v3SeedBody), v3SeedAsset.sha256);
  async function rawLegacyV3(target) {
    return target.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const opening = indexedDB.open("triptych-cpu");
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
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
        const bytes = new TextEncoder().encode(
          JSON.stringify(rows, (_key, value) =>
            value instanceof Uint8Array ? Array.from(value) : value,
          ),
        );
        return {
          sha256: Array.from(
            new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
            (byte) => byte.toString(16).padStart(2, "0"),
          ).join(""),
          stateKeys: rows.state.map((row) => row.key),
          blobCount: rows.blobs.length,
        };
      } finally {
        db.close();
      }
    });
  }
  const v3RawBefore = await rawLegacyV3(migratedV3);
  assert.ok(v3RawBefore.stateKeys.includes("head"));
  assert.ok(v3RawBefore.stateKeys.includes("backup:hosted-v3-change"));
  await migratedV3.unrouteAll();
  const migratedV3Seen = observe(migratedV3, "migrated-v3");
  await boot(migratedV3, true);
  const v3Reopened = await stored(migratedV3);
  assert.equal(v3Reopened.token.kind, "historical");
  assert.equal(v3Reopened.token.store, "drive-set-state");
  assert.deepEqual(v3Reopened.bytes, Array.from(v3HeadBytes));
  assert.equal(v3Reopened.name, "historical-v3.img");
  assert.equal(v3Reopened.b, null);
  assert.deepEqual(v3Reopened.bootstrap.bytes, Array.from(v3Bootstrap));
  assert.equal(v3Reopened.bootstrap.profile, "legacy-e400");
  assert.equal(v3Reopened.backups.length, 1);
  assert.equal(v3Reopened.backups[0].id, "v3:hosted-v3-change");
  assert.deepEqual(v3Reopened.backups[0].bytes, Array.from(legacyBytes));
  assert.equal(v3Reopened.backups[0].name, v3Reopened.name);
  assert.equal(v3Reopened.backups[0].b, null);
  assert.deepEqual(v3Reopened.backups[0].bootstrap, v3Reopened.bootstrap);
  assert.deepEqual(await rawLegacyV3(migratedV3), v3RawBefore);
  await manage(migratedV3);
  const v3Checkpoint = await stored(migratedV3);
  assert.equal(v3Checkpoint.token.kind, "v4");
  assert.deepEqual(v3Checkpoint.bytes, v3Reopened.bytes);
  assert.deepEqual(v3Checkpoint.bootstrap, v3Reopened.bootstrap);
  assert.equal(v3Checkpoint.name, v3Reopened.name);
  assert.equal(v3Checkpoint.b, null);
  assert.equal(v3Checkpoint.backups.length, 2);
  const promotedV3 = v3Checkpoint.backups.find((backup) =>
    backup.id.startsWith("v4:"),
  );
  assert.match(promotedV3.operationId, /^checkpoint:/);
  assert.deepEqual(promotedV3.bytes, Array.from(v3HeadBytes));
  assert.equal(promotedV3.name, v3Reopened.name);
  assert.equal(promotedV3.b, null);
  assert.deepEqual(promotedV3.bootstrap, v3Reopened.bootstrap);
  assert.deepEqual(
    v3Checkpoint.backups.find((backup) => backup.id === "v3:hosted-v3-change"),
    v3Reopened.backups[0],
  );
  assert.deepEqual(await rawLegacyV3(migratedV3), v3RawBefore);
  await migratedV3.locator("#file-import").setInputFiles({
    name: "AFTER.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("Written after v3 promotion\r\n"),
  });
  await expect(migratedV3.locator("#files-status")).toContainText(
    "Staged AFTER.TXT",
  );
  await apply(migratedV3);
  const v3Saved = await stored(migratedV3);
  assert.equal(v3Saved.backups.length, 3);
  for (const backup of v3Checkpoint.backups)
    assert.deepEqual(
      v3Saved.backups.find((entry) => entry.id === backup.id),
      backup,
    );
  const manualV3 = v3Saved.backups.find(
    (entry) => !v3Checkpoint.backups.some((backup) => backup.id === entry.id),
  );
  assert.deepEqual(manualV3.bytes, v3Checkpoint.bytes);
  assert.equal(manualV3.name, v3Checkpoint.name);
  assert.equal(manualV3.b, v3Checkpoint.b);
  assert.deepEqual(manualV3.bootstrap, v3Checkpoint.bootstrap);
  assert.equal(manualV3.revision, v3Checkpoint.revision);
  assert.doesNotMatch(manualV3.operationId, /^checkpoint:/);
  await migratedV3.locator("#close-files").click();
  await savedBoot(migratedV3);
  assert.deepEqual(await stored(migratedV3), v3Saved);
  assert.deepEqual(await rawLegacyV3(migratedV3), v3RawBefore);
  await command(migratedV3, "TYPE V3.TXT");
  await expect(migratedV3.locator("#terminal")).toContainText(
    "Historical version three survives",
  );
  await command(migratedV3, "TYPE AFTER.TXT");
  await expect(migratedV3.locator("#terminal")).toContainText(
    "Written after v3 promotion",
  );

  // A separate disposable context exercises the actual hosted A/B assets and
  // selected-drive UI. Hash complete images without serializing every backup's
  // 16 MiB payload through the browser automation protocol.
  async function setState(page) {
    return page.evaluate(
      async ({ storeUrl, wasmUrl }) => {
        const { openSavedMachineStore } = await import(storeUrl);
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
        const store = await openSavedMachineStore();
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
        storeUrl: new URL("saved-machine-store.js", base).href,
        wasmUrl: new URL("triptych_host_wasm.js", base).href,
      },
    );
  }
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
  // This is an explicit historical saved-machine migration, not a replacement
  // of the public config. Fresh profiles above exercise the actual A/B default.
  await ab.route(appUrl, (route) => route.abort());
  await ab.goto(base.href);
  await ab.evaluate(
    async ({ storeUrl, disk, bootstrap }) => {
      const { openSavedMachineStore } = await import(storeUrl);
      const store = await openSavedMachineStore();
      try {
        const head = await store.load();
        if (head.kind !== "empty")
          throw new Error("Historical fixture was not empty");
        await store.saveCheckpoint(head.token, {
          bootstrap: {
            profile: "legacy-e400",
            bytes: Uint8Array.from(bootstrap),
          },
          drives: {
            A: { name: "historical-small.img", bytes: Uint8Array.from(disk) },
            B: null,
          },
        });
      } finally {
        store.close();
      }
    },
    {
      storeUrl: new URL("saved-machine-store.js", base).href,
      disk: Array.from(await readFile(join(directory, "cpm22.img"))),
      bootstrap: Array.from(await readFile(join(directory, "bootstrap.bin"))),
    },
  );
  await ab.unrouteAll();
  const abSeen = observe(ab, "historical-small-to-eight-mib-ab");
  await boot(ab, true);
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
  for (const name of [
    "ATOM.COM",
    "NUC.COM",
    "EDIT.COM",
    "CAVERNS.COM",
    "HYPERDRV.COM",
    "HYPERD2.COM",
  ]) {
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
  // Durable authority is v4, but these historical A/B snapshots deliberately
  // retain the canonical v3 archive format and its independent decoder.
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

  // This context must actually configure and run the advertised two-MiB
  // profile. The asset-fetch probe above does not establish UI activation.
  async function twoMibState(page) {
    return page.evaluate(async (storeUrl) => {
      const { openSavedMachineStore } = await import(storeUrl);
      const hash = async (bytes) =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
      const store = await openSavedMachineStore();
      try {
        const head = await store.load();
        if (head.kind !== "ready" || head.token.kind !== "v4")
          throw new Error(`Expected v4 authority: ${JSON.stringify(head)}`);
        const describe = async (snapshot) => {
          const image = async (slot) =>
            slot && {
              ...(slot.instanceId ? { instanceId: slot.instanceId } : {}),
              name: slot.name,
              bytes: slot.bytes.length,
              sha256: await hash(slot.bytes),
            };
          const bootstrap = {
            profile: snapshot.bootstrap.profile,
            bytes: snapshot.bootstrap.bytes.length,
            sha256: await hash(snapshot.bootstrap.bytes),
          };
          return snapshot.schema === "triptych-drive-set-v4"
            ? {
                schema: snapshot.schema,
                configuredCount: snapshot.configuredCount,
                bootstrap,
                slots: await Promise.all(snapshot.slots.map(image)),
              }
            : {
                bootstrap,
                drives: {
                  A: await image(snapshot.drives.A),
                  B: await image(snapshot.drives.B),
                },
              };
        };
        const backups = [];
        for (const entry of (await store.listBackups()).sort((a, b) =>
          a.id.localeCompare(b.id),
        )) {
          assertAvailable(entry);
          const snapshot = await store.readBackup(entry.id);
          if (!snapshot) throw new Error(`Missing backup ${entry.id}`);
          backups.push({ ...entry, snapshot: await describe(snapshot) });
        }
        function assertAvailable(entry) {
          if (entry.kind !== "available")
            throw new Error(JSON.stringify(entry));
        }
        return {
          token: head.token,
          snapshot: await describe(head.snapshot),
          backups,
        };
      } finally {
        store.close();
      }
    }, new URL("saved-machine-store.js", base).href);
  }
  function exactMachineBackup(before, after, label) {
    assert.equal(
      after.backups.length,
      before.backups.length + 1,
      `${label}: one new backup`,
    );
    for (const backup of before.backups)
      assert.deepEqual(
        after.backups.find((entry) => entry.id === backup.id),
        backup,
        `${label}: existing backup unchanged`,
      );
    const added = after.backups.filter(
      (entry) => !before.backups.some((backup) => backup.id === entry.id),
    );
    assert.equal(added.length, 1);
    assert.equal(added[0].revision, before.token.revision);
    assert.deepEqual(
      added[0].snapshot,
      before.snapshot,
      `${label}: every preceding image, identity, count and bootstrap retained`,
    );
  }
  function archiveState(snapshot) {
    const image = (slot) =>
      slot && {
        ...(slot.instanceId ? { instanceId: slot.instanceId } : {}),
        name: slot.name,
        bytes: slot.bytes.length,
        sha256: digest(slot.bytes),
      };
    const bootstrap = {
      profile: snapshot.bootstrap.profile,
      bytes: snapshot.bootstrap.bytes.length,
      sha256: digest(snapshot.bootstrap.bytes),
    };
    return snapshot.schema === "triptych-drive-set-v4"
      ? {
          schema: snapshot.schema,
          configuredCount: snapshot.configuredCount,
          bootstrap,
          slots: snapshot.slots.map(image),
        }
      : {
          bootstrap,
          drives: { A: image(snapshot.drives.A), B: image(snapshot.drives.B) },
        };
  }
  const twoMib = await newPage();
  const twoMibSeen = observe(twoMib, "two-mib-sixteen");
  await boot(twoMib);
  await manage(twoMib);
  const beforeSixteen = await twoMibState(twoMib);
  await twoMib.locator("#configured-count").fill("16");
  await twoMib.locator("#configure-drives").click();
  await expect(twoMib.locator("#files-status")).toContainText(
    "16 two-MiB slots staged",
  );
  const letters = Array.from({ length: 16 }, (_, index) =>
    String.fromCharCode(65 + index),
  );
  for (const letter of letters) {
    await twoMib.locator("#file-drive").selectOption(letter);
    if (letter !== "A") {
      if (letter === "B") {
        await twoMib.locator("#eject-drive").click();
        await expect(twoMib.locator("#files-status")).toContainText(
          "B ejection staged",
        );
      }
      await twoMib.locator("#blank-drive").click();
      await expect(twoMib.locator("#files-status")).toContainText(
        `Blank ${letter} staged`,
      );
    }
    await twoMib.locator("#file-import").setInputFiles({
      name: "WHO.TXT",
      mimeType: "text/plain",
      buffer: Buffer.from(`Hosted drive ${letter} sentinel\r\n`),
    });
    await expect(twoMib.locator("#files-status")).toContainText(
      "Staged WHO.TXT",
    );
  }
  assert.deepEqual(
    await twoMibState(twoMib),
    beforeSixteen,
    "All sixteen media remain staged before Apply",
  );
  await apply(twoMib);
  await prompt(twoMib);
  const sixteenSaved = await twoMibState(twoMib);
  exactMachineBackup(
    beforeSixteen,
    sixteenSaved,
    "configure and populate sixteen",
  );
  const sixteenState = sixteenSaved.snapshot;
  assert.equal(sixteenState.configuredCount, 16);
  assert.equal(sixteenState.slots.length, 16);
  for (const index of letters.keys()) {
    assert.ok(sixteenState.slots[index]?.instanceId);
    assert.equal(sixteenState.slots[index].bytes, 2097152);
  }
  assert.equal(
    new Set(sixteenState.slots.map((slot) => slot.instanceId)).size,
    16,
  );
  assert.equal(new Set(sixteenState.slots.map((slot) => slot.sha256)).size, 16);
  const sixteenDescriptor = manifest.twoMibProfiles.find(
    (profile) => profile.configuredCount === 16,
  );
  assert.equal(
    sixteenState.bootstrap.profile,
    sixteenDescriptor.residentProfile,
  );
  assert.equal(sixteenState.bootstrap.bytes, sixteenDescriptor.bootstrap.bytes);
  assert.equal(
    sixteenState.bootstrap.sha256,
    sixteenDescriptor.bootstrap.sha256,
  );
  await twoMib.locator("#close-files").click();
  for (const letter of letters) {
    await command(twoMib, `TYPE ${letter}:WHO.TXT`);
    await expect(twoMib.locator("#terminal")).toContainText(
      `Hosted drive ${letter} sentinel`,
    );
  }
  await savedBoot(twoMib);
  assert.deepEqual(
    await twoMibState(twoMib),
    sixteenSaved,
    "two-MiB reload preserves count, slot identities and every saved byte",
  );
  const twoMibArchiveBytes = await archiveDownload(twoMib, "#download-set");
  const twoMibArchive = await decodeSavedMachineArchive(twoMibArchiveBytes);
  assert.deepEqual(
    archiveState(twoMibArchive),
    sixteenState,
    "download preserves all sixteen complete, distinct media",
  );

  // Change real media before importing the earlier archive, so a no-op restore
  // or metadata-only implementation cannot pass this proof.
  await manage(twoMib);
  const beforeLaterChange = await twoMibState(twoMib);
  await twoMib.locator("#file-drive").selectOption("P");
  await twoMib.locator("#file-import").setInputFiles({
    name: "AFTER.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from(
      "This later P change must be backed up then restored away\r\n",
    ),
  });
  await expect(twoMib.locator("#files-status")).toContainText(
    "Staged AFTER.TXT",
  );
  await apply(twoMib);
  await prompt(twoMib);
  const laterSaved = await twoMibState(twoMib);
  exactMachineBackup(beforeLaterChange, laterSaved, "later P change");
  assert.notEqual(
    laterSaved.snapshot.slots[15].sha256,
    sixteenState.slots[15].sha256,
  );
  assert.deepEqual(
    laterSaved.snapshot.slots.slice(0, 15),
    sixteenState.slots.slice(0, 15),
  );
  await manage(twoMib);
  const beforeArchiveRestore = await twoMibState(twoMib);
  await twoMib.locator("#drive-set-input").setInputFiles({
    name: "all-sixteen.tds",
    mimeType: "application/octet-stream",
    buffer: twoMibArchiveBytes,
  });
  await expect(twoMib.locator("#files-status")).toContainText(
    "Complete drive set staged",
  );
  assert.deepEqual(
    await twoMibState(twoMib),
    beforeArchiveRestore,
    "Complete archive restoration remains staged",
  );
  await apply(twoMib);
  await prompt(twoMib);
  const restoredSixteen = await twoMibState(twoMib);
  assert.deepEqual(
    restoredSixteen.snapshot,
    sixteenState,
    "Archive import restores all images, UUIDs, names, count and bootstrap exactly",
  );
  exactMachineBackup(
    beforeArchiveRestore,
    restoredSixteen,
    "restore all-sixteen archive",
  );
  await twoMib.locator("#close-files").click();
  await savedBoot(twoMib);
  assert.deepEqual(await twoMibState(twoMib), restoredSixteen);

  async function downloadRecovery(target, expected) {
    const headBytes = await archiveDownload(target, "#download-set");
    assert.deepEqual(
      archiveState(await decodeSavedMachineArchive(headBytes)),
      expected.snapshot,
    );
    await target.locator("#files").click();
    const backups = [];
    for (const backup of expected.backups) {
      const pending = target.waitForEvent("download");
      await target
        .locator("#backup-list li")
        .filter({ hasText: backup.id })
        .getByRole("button", { name: "Download set", exact: true })
        .click();
      const path = await (await pending).path();
      assert.ok(path, `${backup.id}: complete backup download finished`);
      const bytes = await readFile(path);
      assert.deepEqual(
        archiveState(await decodeSavedMachineArchive(bytes)),
        backup.snapshot,
        `${backup.id}: downloaded complete backup`,
      );
      backups.push({ id: backup.id, sha256: digest(bytes) });
    }
    await target.locator("#close-files").click();
    return { headSha256: digest(headBytes), backups };
  }
  const onlineRecovery = await downloadRecovery(twoMib, restoredSixteen);
  assert.equal(onlineRecovery.headSha256, digest(twoMibArchiveBytes));

  // Keep the original origin and IndexedDB, but satisfy EVERY request from
  // the exact retained CI site. There is deliberately no route.fetch or live
  // fallback. Saved recovery must not request fresh media or resident bytes.
  const retainedServed = new Set();
  const retainedRejected = [];
  const contentTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  };
  await twoMib.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const name =
      url.origin === base.origin && url.pathname.startsWith(base.pathname)
        ? url.pathname.slice(base.pathname.length) || "index.html"
        : null;
    const asset = manifest.assets.find((entry) => entry.path === name);
    const fresh =
      name &&
      ([
        "config.json",
        "cpm22.img",
        "ccp.bin",
        "bdos.bin",
        "bios.bin",
        ...Object.values(publicDrives.drives).map((drive) => drive.path),
      ].includes(name) ||
        /^bootstrap.*\.bin$/.test(name) ||
        /^system-.*\.bin$/.test(name));
    if ((!asset && name !== "deployment-manifest.json") || fresh) {
      retainedRejected.push(route.request().url());
      await route.abort("blockedbyclient");
      return;
    }
    const body = await readFile(join(directory, name));
    if (asset) {
      assert.equal(body.length, asset.bytes);
      assert.equal(digest(body), asset.sha256);
    } else assert.deepEqual(body, expectedManifest);
    retainedServed.add(name);
    await route.fulfill({
      status: 200,
      contentType: contentTypes[extname(name)] ?? "application/octet-stream",
      body,
    });
  });
  await savedBoot(twoMib);
  assert.deepEqual(
    await twoMibState(twoMib),
    restoredSixteen,
    "Retained-site-only reload preserves complete authority and backups",
  );
  for (const letter of ["A", "P"]) {
    await command(twoMib, `TYPE ${letter}:WHO.TXT`);
    await expect(twoMib.locator("#terminal")).toContainText(
      `Hosted drive ${letter} sentinel`,
    );
  }
  const retainedRecovery = await downloadRecovery(twoMib, restoredSixteen);
  assert.deepEqual(
    retainedRecovery,
    onlineRecovery,
    "Retained-site-only head and every backup download are byte-identical",
  );
  assert.deepEqual(await twoMibState(twoMib), restoredSixteen);
  assert.deepEqual(
    retainedRejected,
    [],
    "No live fallback, fresh-media or resident requests during retained recovery",
  );
  for (const name of [
    "index.html",
    "app.js",
    "triptych_host_wasm_bg.wasm",
    "deployment-manifest.json",
    "saved-machine-store.js",
  ])
    assert.ok(
      retainedServed.has(name),
      `Retained recovery actually served ${name}`,
    );

  for (const { label, seen } of profiles)
    for (const name of [
      "index.html",
      "app.js",
      "triptych_host_wasm.js",
      "triptych_host_wasm_bg.wasm",
      "saved-machine-store.js",
      "saved-machine-workspace.js",
      "saved-machine-runtime.js",
      "saved-machine.js",
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
    !freshSeen.has("cpm22.img"),
    "fresh profile does not load compatibility media",
  );
  for (const name of [
    "config.json",
    publicDrives.bootstrapAsset,
    publicDrives.drives.A.path,
    publicDrives.drives.B.path,
  ])
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
  for (const name of migratedV3Seen)
    assert.ok(
      ![
        "config.json",
        "cpm22.img",
        "ccp.bin",
        "bdos.bin",
        "bios.bin",
        ...Object.values(publicDrives.drives).map((drive) => drive.path),
      ].includes(name) &&
        !/^bootstrap.*\.bin$/.test(name) &&
        !/^system-.*\.bin$/.test(name),
      `v3 retains its exact saved media and bootstrap without fetching ${name}`,
    );
  for (const name of [
    "system-triptych-cpm-8m-ab-v1.bin",
    "bootstrap-triptych-cpm-8m-ab-v1.bin",
  ])
    assert.ok(abSeen.has(name), `A/B UI consumed verified ${name}`);
  for (const name of [
    "two-mib-system.js",
    "drive-set-v4.js",
    sixteenDescriptor.system.asset,
    sixteenDescriptor.bootstrap.asset,
  ])
    assert.ok(twoMibSeen.has(name), `two-MiB UI consumed verified ${name}`);
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
  for (const seen of [migratedSeen, migratedV2Seen, abSeen])
    for (const drive of Object.values(publicDrives.drives))
      assert.ok(
        !seen.has(drive.path),
        "historical saved media is not replaced by public starter images",
      );
  assert.deepEqual(errors, [], "browser execution or asset identity errors");
  console.log(
    JSON.stringify({
      status: "passed",
      url: base.href,
      revision,
      assets: manifest.assets.length,
      diskSha256: manifest.distribution.disk.sha256,
      publicDrives,
      profiles: profiles.map(({ label }) => label),
      workflows: [
        "actual public A tools/B games: exact assets, CAVERNS, HYPERDRV and HYPERD2 launch/save/quit/reload/load/quit, unchanged A",
        "ATOM/run, Edit/NUC/run/save/reload/reopen/run",
        "Files/starter/prepare/compile/win/Edit/rebuild/selected-NUC-update/reload/download/separate-profile-reopen",
        "unmodified hosted app: v1 migration/exact legacy retention/backed-up import/reload/read",
        "genuine v2 authority/exact historical-store retention/promotion/complete preceding backups/reload/read",
        "genuine v3 authority/unchanged before promotion/exact historical-store retention/complete preceding backups/reload/read",
        "hosted A/B migration/blank B/selected B import/tools/ATOM/Edit/NUC/save/reload/full archive/remove B/restore/reload/run with complete backups",
        "hosted two-MiB all sixteen distinct media/Apply/TYPE A through P/exact archive/change P/import restore/complete preceding backups/reload",
        "same-origin retained-CI-site-only v4 recovery/no live fallback or fresh media/resident requests/byte-identical head and every backup download",
      ],
      adventureDiskSha256: digest(downloadedBytes),
      migratedDiskSha256: digest(Buffer.from(migratedSaved.bytes)),
      migratedBackupSha256: digest(Buffer.from(migratedSaved.backups[0].bytes)),
      migratedV3: {
        rawHistoricalStores: v3RawBefore,
        originalHeadSha256: digest(v3HeadBytes),
        bootstrapSha256: digest(v3Bootstrap),
        savedHeadSha256: digest(Buffer.from(v3Saved.bytes)),
        backups: v3Saved.backups.map((backup) => ({
          id: backup.id,
          revision: backup.revision,
          operationId: backup.operationId,
          imageSha256: digest(Buffer.from(backup.bytes)),
          bootstrapSha256: digest(Buffer.from(backup.bootstrap.bytes)),
        })),
      },
      abArchiveSha256: digest(abArchiveBytes),
      abMedia: media(workedAb),
      twoMibArchiveSha256: digest(twoMibArchiveBytes),
      twoMibMedia: sixteenState,
      twoMibRestoredAuthority: restoredSixteen,
      retainedRecovery: {
        manifestSha256: digest(expectedManifest),
        served: [...retainedServed].sort(),
        rejected: retainedRejected,
        ...retainedRecovery,
      },
    }),
  );
} finally {
  await browser.close();
}
