import { openDownloads } from "./downloads-fixture.mjs";
import {
  expect,
  test,
  seedLegacyDisk,
  adoptHistoricalMachine,
} from "./legacy-fixture.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeDriveSet } from "../../../crates/triptych-host-wasm/web/drive-set.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function state(page) {
  return page.evaluate(async () => {
    const { openDiskBoxAppStore } = await import("/disk-box-app-store.js");
    const { CpmDisk } = await import("/triptych_host_wasm.js");
    const hash = async (bytes) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (n) => n.toString(16).padStart(2, "0"),
      ).join("");
    const store = await openDiskBoxAppStore({
      lease: { isOwner: () => false },
    });
    try {
      const head = await store.load();
      if (head.kind !== "ready") throw new Error(head.error ?? head.kind);
      const result = {
        profile: head.snapshot.bootstrap.profile,
        bootstrap: await hash(head.snapshot.bootstrap.bytes),
        drives: {},
      };
      for (const name of ["A", "B"]) {
        const image = head.snapshot.drives[name];
        if (!image) {
          result.drives[name] = null;
          continue;
        }
        const disk = new CpmDisk(image.bytes);
        try {
          const files = {};
          for (const file of disk.file_names())
            files[file] = await hash(disk.read_file(file));
          result.drives[name] = {
            name: image.name,
            bytes: image.bytes.length,
            hash: await hash(image.bytes),
            system: await hash(image.bytes.subarray(0, 16384)),
            files,
          };
        } finally {
          disk.free();
        }
      }
      return result;
    } finally {
      store.close();
    }
  });
}

async function prompt(page, drive = "A") {
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent())
        .trimEnd()
        .endsWith(`${drive}>`),
    )
    .toBe(true);
}

async function command(page, value, drive = "B", returns = true) {
  await prompt(page, drive);
  await page.locator("#terminal").focus();
  await page.keyboard.type(value);
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent())
        .trimEnd()
        .endsWith(`${drive}>${value}`),
    )
    .toBe(true);
  await page.keyboard.press("Enter");
  if (returns) await prompt(page, value === "B:" ? "B" : drive);
}

async function manage(page) {
  if (!(await page.locator("#files-dialog").isVisible()))
    await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#disk-input")).toBeEnabled();
}

async function apply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await prompt(page);
}

test("A/B migration, B tool workflows, complete export and removal/restore preserve independent disks", async ({
  page,
}, info) => {
  test.setTimeout(300000);
  page.on("dialog", (dialog) => dialog.accept());
  await seedLegacyDisk(page);
  await adoptHistoricalMachine(page);
  await prompt(page);
  await manage(page);
  const legacy = await state(page);
  await page.locator("#enable-ab").click();
  await expect(page.locator("#files-status")).toContainText(
    "A/B enabled in the staged set",
  );
  await page.locator("#blank-b").click();
  await expect(page.locator("#files-status")).toContainText(
    "Blank eight MiB B staged",
  );
  expect(await state(page)).toEqual(legacy);
  await apply(page);
  const migrated = await state(page);
  expect(migrated.profile).toBe("triptych-cpu-v0.1-8m-ab");
  expect(migrated.drives.A.bytes).toBe(8388608);
  expect(migrated.drives.A.files).toEqual(legacy.drives.A.files);
  expect(migrated.drives.B.bytes).toBe(8388608);
  expect(migrated.drives.B.files).toEqual({});
  expect(migrated.drives.B.system).toBe(digest(Buffer.alloc(16384)));

  // Import released example source onto B, then install each verified tool
  // through the selected-drive UI. These are file copies, not OS adaptation.
  const sources = await page.evaluate(async () => {
    const { openDiskBoxAppStore } = await import("/disk-box-app-store.js");
    const { CpmDisk } = await import("/triptych_host_wasm.js");
    const store = await openDiskBoxAppStore({
      lease: { isOwner: () => false },
    });
    const head = await store.load();
    const disk = new CpmDisk(head.snapshot.drives.A.bytes);
    try {
      return ["HELLO.ASM", "INPUT.NU"].map((name) => ({
        name,
        bytes: Array.from(disk.read_file(name)),
      }));
    } finally {
      disk.free();
      store.close();
    }
  });
  await manage(page);
  await page.locator("#file-drive").selectOption("B");
  await expect(page.locator("#disk-summary")).toContainText("Drive B:");
  await page.locator("#file-import").setInputFiles(
    sources.map(({ name, bytes }) => ({
      name,
      mimeType: "application/octet-stream",
      buffer: Buffer.from(bytes),
    })),
  );
  await expect(page.locator("#files-status")).toContainText(
    "Staged HELLO.ASM, INPUT.NU",
  );
  for (const name of [
    "ATOM.COM",
    "NUC.COM",
    "EDIT.COM",
    "CAVERNS.COM",
    "HYPERDRV.COM",
    "HYPERD2.COM",
  ]) {
    await page
      .locator("#tool-list li")
      .filter({ hasText: name })
      .getByRole("button")
      .click();
    await expect(page.locator("#files-status")).toContainText(`Staged ${name}`);
  }
  await apply(page);
  const installed = await state(page);
  expect(installed.drives.A).toEqual(migrated.drives.A);
  expect(installed.bootstrap).toBe(migrated.bootstrap);
  expect(installed.drives.B.system).toBe(migrated.drives.B.system);
  await page.locator("#close-files").click();
  await command(page, "B:", "A");
  await command(page, "ATOM HELLO.ASM");
  await expect(page.locator("#terminal")).toContainText("HELLO.COM written");
  await command(page, "HELLO");
  await expect(page.locator("#terminal")).toContainText("Hello from ATOM");
  await command(page, "EDIT INPUT.NU", "B", false);
  await expect(page.locator("#terminal")).toContainText(
    "EDIT INPUT   .NU       ^S Save  ^Q Quit",
  );
  await page.keyboard.press("Control+f");
  await page.keyboard.type("'O'");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toHaveAttribute(
    "data-cursor-column",
    "21",
  );
  await page.keyboard.press("Control+r");
  await page.keyboard.type("'Y'");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText(
    "writeOutputByte('Y') else fail",
  );
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+q");
  await prompt(page, "B");
  await command(page, "NUC INPUT.NU");
  await command(page, "INPUT");
  await expect(page.locator("#terminal")).toContainText("YK");
  await expect
    .poll(async () => (await state(page)).drives.B.files["INPUT.COM"])
    .toBeDefined();
  await manage(page); // The barrier makes the final full checkpoint authoritative.
  const worked = await state(page);
  expect(worked.drives.A).toEqual(migrated.drives.A);
  expect(worked.bootstrap).toBe(migrated.bootstrap);
  expect(worked.drives.B.system).toBe(migrated.drives.B.system);
  expect(worked.drives.B.files["INPUT.NU"]).not.toBe(
    installed.drives.B.files["INPUT.NU"],
  );
  expect(worked.drives.B.files["HELLO.COM"]).toBeDefined();
  await page.locator("#cancel-management").click();
  await page.locator("#close-files").click();
  await expect(page.locator("#files-dialog")).not.toBeVisible();

  const pending = page.waitForEvent("download");
  await openDownloads(page);
  await page.locator("#download-set").click();
  const archivePath = info.outputPath("both-drives.tds");
  await (await pending).saveAs(archivePath);
  const archive = await decodeDriveSet(await readFile(archivePath));
  expect(digest(archive.bootstrap.bytes)).toBe(worked.bootstrap);
  for (const name of ["A", "B"])
    expect(digest(archive.drives[name].bytes)).toBe(worked.drives[name].hash);
  await page.reload();
  await prompt(page);
  expect(await state(page)).toEqual(worked);
  await manage(page);
  await page.locator("#remove-b").click();
  await apply(page);
  const removed = await state(page);
  expect(removed.drives.B).toBeNull();
  expect(removed.drives.A).toEqual(worked.drives.A);
  expect(removed.bootstrap).toBe(worked.bootstrap);
  await manage(page);
  await page.locator("#backup-list [data-restore]").first().click();
  await expect(page.locator("#files-status")).toContainText("staged");
  await apply(page);
  expect(await state(page)).toEqual(worked);
  await manage(page);
  await page.locator("#remove-b").click();
  await apply(page);
  expect(await state(page)).toEqual(removed);
  await manage(page);
  await page.locator("#drive-set-input").setInputFiles(archivePath);
  await expect(page.locator("#files-status")).toContainText(
    "Complete drive set staged",
  );
  expect(await state(page)).toEqual(removed);
  await apply(page);
  expect(await state(page)).toEqual(worked);
  await page.reload();
  await prompt(page);
  expect(await state(page)).toEqual(worked);

  // Stored A/B bootstrap bytes, not today's bootstrap asset, govern reopening.
  let bootstrapFetches = 0;
  await page.route("**/bootstrap*.bin", (route) => {
    bootstrapFetches += 1;
    return route.abort();
  });
  await page.reload();
  await prompt(page);
  expect(await state(page)).toEqual(worked);
  expect(bootstrapFetches).toBe(0);

  // When the emulator itself cannot load, both saved images and bootstrap
  // remain downloadable as the exact portable archive, without a running CPU.
  const recoveryIds = await page.evaluate(async () => {
    const { openDiskBoxStore } = await import("/disk-box-store.js");
    const store = await openDiskBoxStore({ lease: { isOwner: () => false } });
    try {
      const loaded = await store.load();
      const configuration = loaded.manifest.configurations.find(
        (item) => item.id === loaded.manifest.selectedConfigurationId,
      );
      return configuration.slots.map((slot) => {
        if (slot?.kind !== "personal")
          throw new Error("expected retained personal disk");
        return slot.diskId;
      });
    } finally {
      store.close();
    }
  });
  await page.route("**/*.wasm", (route) => route.abort());
  await page.reload();
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#download-set")).toBeEnabled();
  const recoveryDownload = page.waitForEvent("download");
  await openDownloads(page);
  await page.locator("#download-set").click();
  const recoveryPath = info.outputPath("wasm-unavailable.tds");
  await (await recoveryDownload).saveAs(recoveryPath);
  expect(await readFile(recoveryPath)).toEqual(await readFile(archivePath));
  for (const name of ["A", "B"]) {
    const pendingRaw = page.waitForEvent("download");
    await page
      .locator(`[data-recovery-disk-id="${recoveryIds[name === "A" ? 0 : 1]}"]`)
      .click();
    const rawPath = info.outputPath(`raw-${name}.img`);
    await (await pendingRaw).saveAs(rawPath);
    expect(digest(await readFile(rawPath))).toBe(worked.drives[name].hash);
  }
});
