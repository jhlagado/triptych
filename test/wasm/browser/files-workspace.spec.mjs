import { expect, test, useLegacyConfiguration } from "./legacy-fixture.mjs";
import { readFile } from "node:fs/promises";
import {
  installCpm22File,
  readCpm22File,
} from "../../../tools/lib/cpm22-disk.mjs";

const builtDisk = () =>
  readFile(new URL("../../../dist/wasm-browser/cpm22.img", import.meta.url));
async function boot(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await expect(page.locator("#terminal")).toContainText("A>");
}
async function manage(page) {
  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
}
async function head(page) {
  return page.evaluate(async () => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    let store = await openDriveSetStore();
    try {
      let value = await store.load();
      if (
        value.kind === "recovery" &&
        value.error ===
          "Historical bootstrap is required to reopen the saved legacy disk."
      ) {
        store.close();
        const legacyBootstrap = new Uint8Array(
          await (await fetch("/bootstrap.bin")).arrayBuffer(),
        );
        store = await openDriveSetStore({ legacyBootstrap });
        value = await store.load();
      }
      if (value.kind !== "ready")
        throw new Error(`Expected ready saved state: ${JSON.stringify(value)}`);
      return {
        kind: value.kind,
        token: value.token,
        receipt: value.receipt,
        name: value.snapshot.drives.A.name,
        bName: value.snapshot.drives.B?.name ?? null,
        bytes: Array.from(value.snapshot.drives.A.bytes),
        b: value.snapshot.drives.B
          ? Array.from(value.snapshot.drives.B.bytes)
          : null,
        bootstrap: {
          profile: value.snapshot.bootstrap.profile,
          bytes: Array.from(value.snapshot.bootstrap.bytes),
        },
        backups: (await store.listBackups()).sort(
          (a, b) => b.revision - a.revision || a.id.localeCompare(b.id),
        ),
      };
    } finally {
      store.close();
    }
  });
}
async function apply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
}

test("file import/export is staged, backed up, executable through TYPE, and reload-safe", async ({
  page,
}, info) => {
  await boot(page);
  await manage(page);
  const before = await head(page);
  const contents = Buffer.from("Browser import\r\n");
  await page.locator("#file-import").setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: contents,
  });
  await expect(page.locator("#files-status")).toContainText("Staged NOTE.TXT");
  expect(await head(page)).toEqual(before);
  await apply(page);
  const after = await head(page);
  expect(after.backups).toHaveLength(1);
  expect(
    readCpm22File(Uint8Array.from(after.bytes), "NOTE.TXT").subarray(
      0,
      contents.length,
    ),
  ).toEqual(Uint8Array.from(contents));
  const row = page.locator("#file-list li").filter({ hasText: "NOTE.TXT" });
  const pending = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const download = await pending;
  const path = info.outputPath("NOTE.TXT");
  await download.saveAs(path);
  const exported = await readFile(path);
  expect(exported.length).toBe(128);
  expect(exported.subarray(0, contents.length)).toEqual(contents);
  expect([...exported.subarray(contents.length)]).toEqual(
    new Array(128 - contents.length).fill(26),
  );
  await page.locator("#close-files").click();
  await page.locator("#terminal").focus();
  await page.keyboard.type("TYPE NOTE.TXT");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("Browser import");
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  expect((await head(page)).bytes).toEqual(after.bytes);
});

test("rejected and cancelled imports preserve the committed disk", async ({
  page,
}) => {
  await boot(page);
  await manage(page);
  const before = await head(page);
  for (const file of [
    { name: "TOO-LONG-NAME.TXT", buffer: Buffer.from("bad") },
    { name: "EMPTY.TXT", buffer: Buffer.alloc(0) },
  ]) {
    await page
      .locator("#file-import")
      .setInputFiles({ ...file, mimeType: "application/octet-stream" });
    await expect(page.locator("#files-status")).toContainText(
      file.buffer.length ? "filename" : "at least one byte",
    );
    expect(await head(page)).toEqual(before);
    await expect(page.locator("#commit-disk")).toBeDisabled();
  }
  await page.locator("#file-import").setInputFiles({
    name: "CANCEL.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("cancel"),
  });
  await expect(page.locator("#commit-disk")).toBeEnabled();
  await page.locator("#cancel-management").click();
  expect(await head(page)).toEqual(before);
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
});

test("a selected unknown tool updates only after verification and retains source and other tools", async ({
  page,
}) => {
  let disk = await builtDisk();
  disk = Buffer.from(
    installCpm22File(disk, { name: "NUC.COM", bytes: Uint8Array.of(201) }),
  );
  disk = Buffer.from(
    installCpm22File(disk, {
      name: "KEEP.NU",
      bytes: Buffer.from("saved source\r\n"),
    }),
  );
  await page.route("**/cpm22.img", (route) =>
    route.fulfill({ contentType: "application/octet-stream", body: disk }),
  );
  await boot(page);
  await manage(page);
  const row = page.locator("#tool-list li").filter({ hasText: "NUC.COM" });
  await expect(row).toContainText("different-unknown");
  const before = await head(page);
  page.on("dialog", (dialog) => dialog.accept());
  await row.getByRole("button").click();
  await expect(page.locator("#files-status")).toContainText("Staged NUC.COM");
  expect(await head(page)).toEqual(before);
  await apply(page);
  const after = await head(page);
  const result = Uint8Array.from(after.bytes);
  for (const name of ["ATOM.COM", "EDIT.COM", "KEEP.NU"])
    expect(readCpm22File(result, name)).toEqual(readCpm22File(disk, name));
  expect(readCpm22File(result, "NUC.COM")).toEqual(
    readCpm22File(await builtDisk(), "NUC.COM"),
  );
  expect(after.backups).toHaveLength(1);
});

test("failed tool asset verification leaves disk and staging unchanged", async ({
  page,
}) => {
  await page.route("**/tool-nucleus-*.com", (route) =>
    route.fulfill({
      body: Buffer.from("wrong"),
      contentType: "application/octet-stream",
    }),
  );
  await boot(page);
  await manage(page);
  const before = await head(page);
  await page
    .locator("#tool-list li")
    .filter({ hasText: "NUC.COM" })
    .getByRole("button")
    .click();
  await expect(page.locator("#files-status")).toContainText(
    "verification failed",
  );
  expect(await head(page)).toEqual(before);
  await expect(page.locator("#commit-disk")).toBeDisabled();
});

test("migration reopens exact legacy bytes without overlaying resident system slots", async ({
  page,
}) => {
  const bytes = [...(await builtDisk())];
  bytes[2047] ^= 0x5a;
  await page.addInitScript(async (bytes) => {
    window.legacySeed = new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-cpu", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("working-disks", { keyPath: "key" });
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("working-disks", "readwrite");
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
        tx.onabort = () => reject(tx.error);
      };
      request.onerror = () => reject(request.error);
    });
  }, bytes);
  // Seed completes before app initialization; the response waits on this promise.
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `await window.legacySeed;\n${await response.text()}`,
    });
  });
  await boot(page);
  expect((await head(page)).bytes).toEqual(bytes);
});

test("a second tab is read-only and cannot enter disk management", async ({
  page,
  context,
}) => {
  await boot(page);
  const other = await context.newPage();
  await useLegacyConfiguration(other);
  await boot(other);
  await expect(other.locator("#save-status")).toContainText("Read-only tab");
  await other.locator("#files").click();
  await other.locator("#saved-and-exited").check();
  await expect(other.locator("#begin-management")).toBeDisabled();
  await page.close();
  await other.reload();
  await expect(other.locator("#save-status")).toHaveText(
    "Working disk saved in this browser.",
  );
});

test("aborted manual publication keeps the head and backups unchanged and retries once", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, ...rest) {
      if (
        globalThis.abortManual &&
        this.name === "drive-set-state" &&
        value?.key?.startsWith("backup:")
      ) {
        globalThis.abortManual = false;
        globalThis.manualProbeTriggered = true;
        throw new DOMException("Manual quota probe", "QuotaExceededError");
      }
      return add.call(this, value, ...rest);
    };
  });
  await boot(page);
  await manage(page);
  const before = await head(page);
  await page.locator("#file-import").setInputFiles({
    name: "RETRY.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("retry"),
  });
  await expect(page.locator("#commit-disk")).toBeEnabled();
  await page.evaluate(() => {
    globalThis.abortManual = true;
  });
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText(
    "Manual quota probe",
  );
  expect(await page.evaluate(() => globalThis.manualProbeTriggered)).toBe(true);
  expect(await head(page)).toEqual(before);
  await expect(page.locator("#commit-disk")).toBeEnabled();
  await apply(page);
  expect((await head(page)).backups).toHaveLength(1);
});

test("backup restoration preserves exact bytes and backs up the displaced disk", async ({
  page,
}) => {
  await boot(page);
  await manage(page);
  const original = await head(page);
  await page.locator("#file-import").setInputFiles({
    name: "UNDO.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("undo"),
  });
  await expect(page.locator("#commit-disk")).toBeEnabled();
  await apply(page);
  const changed = await head(page);
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-list [data-restore]").first().click();
  await expect(page.locator("#files-status")).toContainText("staged");
  await apply(page);
  const restored = await head(page);
  expect(restored.bytes).toEqual(original.bytes);
  expect(restored.backups).toHaveLength(2);
  const displaced = await page.evaluate(async (id) => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    const store = await openDriveSetStore();
    try {
      return Array.from((await store.readBackup(id)).drives.A.bytes);
    } finally {
      store.close();
    }
  }, restored.backups[0].id);
  expect(displaced).toEqual(changed.bytes);
});

test("a delayed file read from a cancelled session cannot stage into its replacement", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const read = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = function () {
      if (this.name === "LATE.TXT")
        return new Promise((resolve) => {
          globalThis.finishLateRead = () =>
            resolve(new TextEncoder().encode("late").buffer);
        });
      return read.call(this);
    };
  });
  await boot(page);
  await manage(page);
  await page.locator("#file-import").setInputFiles({
    name: "LATE.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("late"),
  });
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.finishLateRead))
    .toBe("function");
  await page.locator("#cancel-management").click();
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
  const before = await head(page);
  await page.evaluate(() => globalThis.finishLateRead());
  await expect(page.locator("#files-status")).toContainText(
    "session has ended",
  );
  expect(await head(page)).toEqual(before);
  await expect(page.locator("#commit-disk")).toBeDisabled();
});

test("corrupt legacy data enters recovery without seeding over the original record", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.legacySeed = new Promise((resolve) => {
      const request = indexedDB.open("triptych-cpu", 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore("working-disks", { keyPath: "key" });
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction("working-disks", "readwrite");
        tx.objectStore("working-disks").put({
          schema: "unknown",
          key: "drive-a",
          name: "precious.img",
          bytes: new Uint8Array(512).fill(91),
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
  });
  await page.route("**/app.js", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: `await window.legacySeed;\n${await response.text()}`,
    });
  });
  await page.goto("/");
  await expect(page.locator("#status")).toContainText("Recovery required");
  await expect(page.locator("#legacy-recovery")).toBeVisible();
  const original = await page.evaluate(async () => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    const store = await openDriveSetStore();
    try {
      const value = await store.readRawRecovery("working-disks", "drive-a");
      return { schema: value.schema, bytes: Array.from(value.bytes) };
    } finally {
      store.close();
    }
  });
  expect(original).toEqual({
    schema: "unknown",
    bytes: new Array(512).fill(91),
  });
});

for (const newerAction of ["disk", "file"]) {
  test(`a newer ${newerAction} stage supersedes an older delayed disk selection`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const read = File.prototype.arrayBuffer;
      File.prototype.arrayBuffer = function () {
        if (this.name === "old.img")
          return new Promise((resolve) => {
            globalThis.finishOldDisk = async () =>
              resolve(await read.call(this));
          });
        return read.call(this);
      };
    });
    await boot(page);
    await manage(page);
    const original = await builtDisk();
    const old = Buffer.from(original);
    old[old.length - 1] = 0x11;
    const newest = Buffer.from(original);
    newest[newest.length - 1] = 0x22;
    await page.locator("#disk-input").setInputFiles({
      name: "old.img",
      mimeType: "application/octet-stream",
      buffer: old,
    });
    await expect
      .poll(() => page.evaluate(() => typeof globalThis.finishOldDisk))
      .toBe("function");
    if (newerAction === "disk")
      await page.locator("#disk-input").setInputFiles({
        name: "new.img",
        mimeType: "application/octet-stream",
        buffer: newest,
      });
    else
      await page.locator("#file-import").setInputFiles({
        name: "NEW.TXT",
        mimeType: "text/plain",
        buffer: Buffer.from("newest"),
      });
    await expect(page.locator("#commit-disk")).toBeEnabled();
    await page.evaluate(() => globalThis.finishOldDisk());
    await expect(page.locator("#files-status")).toContainText("superseded");
    await apply(page);
    const actual = Uint8Array.from((await head(page)).bytes);
    if (newerAction === "disk") expect(actual).toEqual(Uint8Array.from(newest));
    else {
      expect(actual.at(-1)).toBe(original.at(-1));
      expect(
        Buffer.from(readCpm22File(actual, "NEW.TXT")).subarray(0, 6).toString(),
      ).toBe("newest");
    }
  });
}

test("closing while management entry saves cancels the eventual session and resumes input", async ({
  page,
}) => {
  await page.route("**/drive-set-store.js", async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = "publish(expected, undefined, snapshot, false),";
    expect(source).toContain(marker);
    await route.fulfill({
      response,
      body: source.replace(
        marker,
        `(async () => {if(globalThis.pauseCheckpoint) {globalThis.pauseCheckpoint=false;await new Promise(resolve=>{globalThis.finishCheckpoint=resolve;});} return publish(expected, undefined, snapshot, false);})(),`,
      ),
    });
  });
  await boot(page);
  await page.evaluate(() => {
    globalThis.pauseCheckpoint = true;
  });
  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.finishCheckpoint))
    .toBe("function");
  await page.locator("#close-files").click();
  await page.evaluate(() => globalThis.finishCheckpoint());
  await expect(page.locator("#reset")).toBeEnabled();
  await expect(page.locator("#files-dialog")).not.toBeVisible();
  await page.locator("#terminal").focus();
  await page.keyboard.type("DIR");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("ATOM");
});

test("saved v3 work boots without downloading a replacement bootstrap", async ({
  page,
}, info) => {
  await boot(page);
  const saved = await head(page);
  let bootstrapRequests = 0;
  await page.route("**/bootstrap.bin", (route) => {
    bootstrapRequests++;
    return route.fulfill({ status: 503, body: "Unavailable" });
  });
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await expect(page.locator("#terminal")).toContainText("A>");
  expect(bootstrapRequests).toBe(0);
  await expect(page.locator("#download")).toBeEnabled();
  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await pending;
  const path = info.outputPath("retained-bootstrap.img");
  await download.saveAs(path);
  expect(await readFile(path)).toEqual(Buffer.from(saved.bytes));
  await page.locator("#files").click();
  await expect(page.locator("#file-list")).toContainText("NUC.COM");
  expect(await head(page)).toEqual(saved);
});

test("failed WASM download retains exact saved-disk recovery access", async ({
  page,
}, info) => {
  await boot(page);
  const saved = await head(page);
  let failedRequests = 0;
  await page.route("**/triptych_host_wasm_bg.wasm", (route) => {
    failedRequests++;
    return route.fulfill({ status: 503, body: "Unavailable" });
  });
  await page.reload();
  await expect(page.locator("#status")).toContainText("Recovery required");
  expect(failedRequests).toBeGreaterThan(0);
  await expect(page.locator("#download")).toBeEnabled();
  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  const path = info.outputPath("recover-after-wasm-failure.img");
  await (await pending).saveAs(path);
  expect(await readFile(path)).toEqual(Buffer.from(saved.bytes));
  expect(await head(page)).toEqual(saved);
});

test("a nonbooting disk can be recovered from its saved backup without guest readiness", async ({
  page,
}) => {
  await boot(page);
  await manage(page);
  const original = await head(page);
  await page.locator("#disk-input").setInputFiles({
    name: "unbootable.img",
    mimeType: "application/octet-stream",
    buffer: Buffer.alloc(512),
  });
  await expect(page.locator("#commit-disk")).toBeEnabled();
  await apply(page);
  await page.locator("#close-files").click();
  await page.reload();
  await expect(page.locator("#terminal")).toContainText("E");
  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#files-status")).toContainText("not idle");
  await expect(page.locator("#disk-input")).toBeDisabled();
  const broken = await head(page);
  await page
    .getByText("Guest stuck or disk will not boot?", { exact: true })
    .click();
  await expect(page.locator("#begin-recovery")).toBeDisabled();
  await page.locator("#discard-volatile").check();
  await page.locator("#begin-recovery").click();
  await expect(page.locator("#disk-input")).toBeEnabled();
  expect(await head(page)).toEqual(broken);
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#backup-list [data-restore]").first().click();
  await expect(page.locator("#commit-disk")).toBeEnabled();
  await apply(page);
  const restored = await head(page);
  expect(restored.bytes).toEqual(original.bytes);
  expect(restored.backups).toHaveLength(2);
  await page.locator("#close-files").click();
  await expect(page.locator("#terminal")).toContainText("A>");
  await page.reload();
  await expect(page.locator("#terminal")).toContainText("A>");
  expect((await head(page)).bytes).toEqual(original.bytes);
});
