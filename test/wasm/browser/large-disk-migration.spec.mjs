import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const asset = "system-triptych-cpm-8m-v1.bin";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const built = (name) =>
  readFile(new URL(`../../../dist/wasm-browser/${name}`, import.meta.url));

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
  await expect(page.locator("#file-import")).toBeEnabled();
}

async function state(page) {
  return page.evaluate(async () => {
    const { openRevisionedDiskStore } =
      await import("/working-disk-revisions.js");
    const { CpmDisk } = await import("/triptych_host_wasm.js");
    const hash = async (bytes) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    const store = await openRevisionedDiskStore();
    let disk;
    try {
      const head = await store.load();
      disk = new CpmDisk(head.bytes);
      const files = {};
      for (const name of disk.file_names())
        files[name] = await hash(disk.read_file(name));
      const backups = [];
      for (const backup of await store.listBackups()) {
        const before = await store.readBackup(backup.operationId);
        backups.push({
          operationId: backup.operationId,
          bytes: before.bytes.length,
          sha256: await hash(before.bytes),
        });
      }
      return {
        revision: head.revision,
        bytes: head.bytes.length,
        sha256: await hash(head.bytes),
        geometry: disk.geometry_id(),
        files,
        backups,
      };
    } finally {
      disk?.free();
      store.close();
    }
  });
}

async function stage(page) {
  await page.locator("#migrate-large-disk").click();
  await expect(page.locator("#files-status")).toContainText(
    "8 MiB upgrade staged",
  );
}

async function apply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await expect(page.locator("#terminal")).toContainText("A>");
}

test("upgrade preserves files, exports exactly, reloads, updates tools and restores its exact legacy backup", async ({
  page,
}, info) => {
  await boot(page);
  await manage(page);
  const before = await state(page);
  expect(before.bytes).toBe(256512);
  expect(before.sha256).toBe(digest(await built("cpm22.img")));
  page.on("dialog", (dialog) => dialog.accept());
  await stage(page);
  expect(await state(page)).toEqual(before);
  await apply(page);
  const large = await state(page);
  expect(large.geometry).toBe("triptych-cpm-8m-v1");
  expect(large.bytes).toBe(8388608);
  expect(large.files).toEqual(before.files);
  expect(large.backups).toHaveLength(1);
  expect(large.backups[0].sha256).toBe(before.sha256);
  await expect(page.locator("#disk-summary")).toContainText("8 MiB");
  await expect(page.locator("#migrate-large-disk")).toBeDisabled();
  await page.locator("#close-files").click();
  const downloaded = page.waitForEvent("download");
  await page.locator("#download").click();
  const path = info.outputPath("large.img");
  await (await downloaded).saveAs(path);
  const exported = await readFile(path);
  expect(exported.length).toBe(8388608);
  expect(digest(exported)).toBe(large.sha256);
  expect(exported.subarray(0, 16384)).toEqual(await built(asset));
  await page.reload();
  await expect(page.locator("#terminal")).toContainText("A>");
  expect(await state(page)).toEqual(large);
  await page.locator("#terminal").focus();
  await page.keyboard.type("TYPE INPUT.NU");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("writeOutputByte");
  await manage(page);
  await page
    .locator("#tool-list li")
    .filter({ hasText: "NUC.COM" })
    .getByRole("button")
    .click();
  await expect(page.locator("#files-status")).toContainText("Staged NUC.COM");
  await apply(page);
  const updated = await state(page);
  expect(updated.bytes).toBe(8388608);
  expect(updated.files).toEqual(large.files);
  await manage(page);
  // The oldest backup is the pre-upgrade legacy disk, not the tool-update backup.
  await page.locator("#backup-list [data-restore]").last().click();
  await expect(page.locator("#files-status")).toContainText("staged");
  await apply(page);
  const restored = await state(page);
  expect(restored.sha256).toBe(before.sha256);
  expect(restored.geometry).toBe("ibm3740");
  expect(restored.backups[0].sha256).toBe(updated.sha256);
  await page.reload();
  await expect(page.locator("#terminal")).toContainText("A>");
  expect((await state(page)).sha256).toBe(before.sha256);
});

test("pending imports block upgrade and cancellation preserves the legacy disk", async ({
  page,
}) => {
  await boot(page);
  await manage(page);
  const before = await state(page);
  await page.locator("#file-import").setInputFiles({
    name: "KEEP.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("pending"),
  });
  await expect(page.locator("#files-status")).toContainText("Staged KEEP.TXT");
  await expect(page.locator("#migrate-large-disk")).toBeDisabled();
  expect(await state(page)).toEqual(before);
  await page.locator("#cancel-management").click();
  expect(await state(page)).toEqual(before);
  await manage(page);
  const baseline = await state(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.locator("#migrate-large-disk").click();
  await expect(page.locator("#commit-disk")).toBeDisabled();
  expect(await state(page)).toEqual(baseline);
  page.once("dialog", (dialog) => dialog.accept());
  await stage(page);
  await page.locator("#cancel-management").click();
  expect(await state(page)).toEqual(baseline);
});

for (const mode of ["cancelled", "superseded"]) {
  test(`delayed upgrade from a ${mode} request cannot replace newer work`, async ({
    page,
  }) => {
    let release;
    let observed;
    const fetched = new Promise((resolve) => {
      observed = resolve;
    });
    const wait = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(`**/${asset}`, async (route) => {
      observed();
      await wait;
      await route.fulfill({
        body: await built(asset),
        contentType: "application/octet-stream",
      });
    });
    await boot(page);
    await manage(page);
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#migrate-large-disk").click();
    await fetched;
    if (mode === "cancelled") {
      await page.locator("#cancel-management").click();
      await manage(page);
    }
    const before = await state(page);
    await page.locator("#file-import").setInputFiles({
      name: "NEW.TXT",
      mimeType: "text/plain",
      buffer: Buffer.from("newer work"),
    });
    await expect(page.locator("#files-status")).toContainText("Staged NEW.TXT");
    release();
    await expect(page.locator("#files-status")).toContainText(
      mode === "cancelled" ? "session has ended" : "superseded",
    );
    expect(await state(page)).toEqual(before);
    await apply(page);
    const after = await state(page);
    expect(after.geometry).toBe("ibm3740");
    expect(after.files["NEW.TXT"]).toBeDefined();
  });
}

for (const mode of ["hash", "profile", "mixed-bootstrap", "network"]) {
  test(`failed ${mode} verification preserves disk and staging`, async ({
    page,
  }) => {
    if (mode === "hash" || mode === "network") {
      await page.route(`**/${asset}`, (route) =>
        mode === "network"
          ? route.abort()
          : route.fulfill({
              body: Buffer.alloc(16384),
              contentType: "application/octet-stream",
            }),
      );
    } else {
      await page.route("**/deployment-manifest.json", async (route) => {
        const value = JSON.parse(await built("deployment-manifest.json"));
        if (mode === "profile") value.diskProfiles[0].drives = 2;
        else value.diskProfiles[0].bootstrapSha256 = "0".repeat(64);
        await route.fulfill({ json: value });
      });
    }
    await boot(page);
    await manage(page);
    const before = await state(page);
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#migrate-large-disk").click();
    await expect(page.locator("#files-status")).toContainText(
      mode === "network" ? "fetch" : "Disk upgrade:",
    );
    await expect(page.locator("#commit-disk")).toBeDisabled();
    expect(await state(page)).toEqual(before);
  });
}

test("quota failure atomically preserves legacy head and backup, then retries one upgrade", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const add = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (value, ...rest) {
      if (globalThis.failMigration && value?.key?.startsWith("change:")) {
        globalThis.failMigration = false;
        throw new DOMException("Migration quota probe", "QuotaExceededError");
      }
      return add.call(this, value, ...rest);
    };
  });
  await boot(page);
  await manage(page);
  const before = await state(page);
  page.on("dialog", (dialog) => dialog.accept());
  await stage(page);
  await page.evaluate(() => {
    globalThis.failMigration = true;
  });
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText(
    "Migration quota probe",
  );
  expect(await state(page)).toEqual(before);
  await apply(page);
  const after = await state(page);
  expect(after.geometry).toBe("triptych-cpm-8m-v1");
  expect(after.backups).toHaveLength(1);
  expect(after.backups[0].sha256).toBe(before.sha256);
});

test("large adaptation selects its verified BIOS and preserves the reserved tail", async ({
  page,
}) => {
  await boot(page);
  await manage(page);
  page.on("dialog", (dialog) => dialog.accept());
  await stage(page);
  await apply(page);
  await page.locator("#close-files").click();
  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await pending;
  const bytes = await readFile(await download.path());
  bytes.fill(0x5a, 0x1a00, 0x4000);
  bytes.fill(0, 0, 0x1a00);
  const expected = Buffer.from(bytes);
  expected.set((await built(asset)).subarray(0, 0x1a00));
  await manage(page);
  await page.locator("#adapt-image").check();
  await page.locator("#disk-input").setInputFiles({
    name: "large.img",
    mimeType: "application/octet-stream",
    buffer: bytes,
  });
  await expect(page.locator("#files-status")).toContainText(
    "explicit system adaptation",
  );
  await apply(page);
  expect((await state(page)).sha256).toBe(digest(expected));
});

test("the upgraded browser runs ATOM, Edit and NUC and reopens their compiled programs", async ({
  page,
}) => {
  const terminal = page.locator("#terminal");
  const prompt = async () => {
    await expect
      .poll(async () => (await terminal.textContent()).trimEnd().endsWith("A>"))
      .toBe(true);
  };
  const command = async (value, returns = true) => {
    await prompt();
    await terminal.focus();
    await page.keyboard.type(value);
    // Observe the current line before Enter; a retained old echo/prompt is not readiness.
    await expect
      .poll(async () =>
        (await terminal.textContent()).trimEnd().endsWith(`A>${value}`),
      )
      .toBe(true);
    await page.keyboard.press("Enter");
    if (returns) await prompt();
  };
  await boot(page);
  await manage(page);
  page.on("dialog", (dialog) => dialog.accept());
  await stage(page);
  await apply(page);
  const migrated = await state(page);
  await page.locator("#close-files").click();
  await command("ATOM HELLO.ASM");
  await expect(terminal).toContainText("HELLO.COM written");
  await command("HELLO");
  await expect(terminal).toContainText("Hello from ATOM");
  await command("EDIT INPUT.NU", false);
  await expect(terminal).toContainText(
    "EDIT INPUT   .NU       ^S Save  ^Q Quit",
  );
  await page.keyboard.press("Control+f");
  await page.keyboard.type("'O'");
  await page.keyboard.press("Enter");
  await expect(terminal).toHaveAttribute("data-cursor-row", "2");
  await expect(terminal).toHaveAttribute("data-cursor-column", "21");
  await page.keyboard.press("Control+r");
  await page.keyboard.type("'Y'");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("writeOutputByte('Y') else fail");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+q");
  await prompt();
  await command("NUC INPUT.NU");
  await command("INPUT");
  await expect(terminal).toContainText("YK");
  await expect
    .poll(async () => (await state(page)).files["INPUT.COM"])
    .toBeDefined();
  const saved = await state(page);
  expect(saved.bytes).toBe(8388608);
  expect(saved.files["HELLO.COM"]).toBeDefined();
  expect(saved.files["INPUT.NU"]).not.toBe(migrated.files["INPUT.NU"]);
  await page.reload();
  await expect(terminal).toContainText("A>");
  expect(await state(page)).toEqual(saved);
  await command("INPUT");
  await expect(terminal).toContainText("YK");
  await command("HELLO");
  await expect(terminal).toContainText("Hello from ATOM");
  expect((await state(page)).sha256).toBe(saved.sha256);
});
