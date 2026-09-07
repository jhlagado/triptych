import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { decodeDriveSet } from "../../../crates/triptych-host-wasm/web/drive-set.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function manage(page) {
  if (!(await page.locator("#files-dialog").isVisible()))
    await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
}

async function apply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await expect(page.locator("#terminal")).toContainText("A>");
}

// Exercise the actual verified migration assets and shared blank-disk API via
// the UI, without installing synthetic resident bytes or writing around CAS.
async function setup(page) {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  await manage(page);
  await expect(page.locator("#enable-ab")).toBeEnabled();
  await page.locator("#enable-ab").click();
  await expect(page.locator("#files-status")).toContainText("A/B enabled");
  await page.locator("#blank-b").click();
  await apply(page);
  await manage(page);
}

async function rawState(page) {
  return page.evaluate(async () => {
    const { openSavedMachineStore } = await import("/saved-machine-store.js");
    const store = await openSavedMachineStore();
    const hash = async (bytes) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    try {
      const head = await store.readRawRecovery("drive-set-state-v4", "head");
      const images = {};
      for (const [name, ref] of [
        ["bootstrap", head.manifest.bootstrap.image],
        ["A", head.manifest.drives.A.image],
        ["B", head.manifest.drives.B.image],
      ]) {
        const raw = await store.readRawRecovery(
          "drive-set-blobs-v4",
          ref.sha256,
        );
        images[name] = {
          length: raw.bytes.length,
          hash: await hash(raw.bytes),
        };
      }
      return { head, images, backups: await store.listBackups() };
    } finally {
      store.close();
    }
  });
}

async function downloaded(page, info, locator, name) {
  const pending = page.waitForEvent("download");
  await locator.click();
  const path = info.outputPath(name);
  await (await pending).saveAs(path);
  return readFile(path);
}

for (const corruption of ["head digest", "B payload"]) {
  test(`A/B ${corruption} corruption fails closed with exact raw downloads and independent backup`, async ({
    page,
  }, info) => {
    await setup(page);
    const before = await rawState(page);
    // This creates a unique B blob so corruption of the new head's B does not
    // corrupt the deliberately independent preceding complete-set backup.
    await page.locator("#file-drive").selectOption("B");
    await page.locator("#file-import").setInputFiles({
      name: "MARK.TXT",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("new B payload\r\n"),
    });
    await expect(page.locator("#files-status")).toContainText(
      "Staged MARK.TXT",
    );
    await apply(page);
    await manage(page); // Pause before fault injection; no live writer races.
    const good = await rawState(page);
    expect(good.images.A).toEqual(before.images.A);
    expect(good.images.bootstrap).toEqual(before.images.bootstrap);
    expect(good.images.B.hash).not.toBe(before.images.B.hash);
    const backup = good.backups.find(
      (item) => item.revision === before.head.revision,
    );
    expect(backup).toBeDefined();
    await page.evaluate(async (corruption) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("triptych-cpu", 4);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        await new Promise((resolve, reject) => {
          const tx = db.transaction(
            ["drive-set-state-v4", "drive-set-blobs-v4"],
            "readwrite",
          );
          tx.oncomplete = resolve;
          tx.onabort = () => reject(tx.error);
          const state = tx.objectStore("drive-set-state-v4");
          const get = state.get("head");
          get.onsuccess = () => {
            const head = get.result;
            if (corruption === "head digest") {
              head.digest =
                head.digest === "0".repeat(64)
                  ? "1".repeat(64)
                  : "0".repeat(64);
              state.put(head);
            } else {
              const blobs = tx.objectStore("drive-set-blobs-v4");
              const image = blobs.get(head.manifest.drives.B.image.sha256);
              image.onsuccess = () => {
                const raw = image.result;
                raw.bytes[raw.bytes.length - 1] ^= 0xff;
                blobs.put(raw);
              };
            }
          };
        });
      } finally {
        db.close();
      }
    }, corruption);
    const corrupt = await rawState(page);
    if (corruption === "head digest") {
      expect(corrupt.images).toEqual(good.images);
      expect(corrupt.head.digest).not.toBe(good.head.digest);
    } else {
      expect(corrupt.images.B.hash).not.toBe(good.images.B.hash);
      expect(corrupt.head).toEqual(good.head);
    }
    let seedRequests = 0;
    await page.route("**/cpm22.img", (route) => {
      seedRequests++;
      return route.abort();
    });
    await page.reload();
    await expect(page.locator("#status")).toContainText("Recovery required");
    await expect(page.locator("#download-set")).toBeDisabled();
    for (const name of ["A", "B", "bootstrap"]) {
      const bytes = await downloaded(
        page,
        info,
        page.getByRole("button", {
          name: `Download raw v4 ${name}`,
          exact: true,
        }),
        `raw-${name}.bin`,
      );
      expect(bytes.length).toBe(corrupt.images[name].length);
      expect(hash(bytes)).toBe(corrupt.images[name].hash);
    }
    const manifest = await downloaded(
      page,
      info,
      page.getByRole("button", { name: "Download raw v4 saved manifest" }),
      "raw-head.json",
    );
    expect(JSON.parse(manifest.toString())).toEqual(corrupt.head);
    await page.locator("#files").click();
    const row = page.locator("#backup-list li").filter({ hasText: backup.id });
    const archive = await decodeDriveSet(
      await downloaded(
        page,
        info,
        row.getByRole("button", { name: "Download set", exact: true }),
        "independent-backup.tds",
      ),
    );
    expect(hash(archive.bootstrap.bytes)).toBe(before.images.bootstrap.hash);
    for (const name of ["A", "B"])
      expect(hash(archive.drives[name].bytes)).toBe(before.images[name].hash);
    expect(seedRequests).toBe(0);
    expect(await rawState(page)).toEqual(corrupt);
  });
}

for (const action of ["tool", "file", "image"]) {
  test(`delayed A ${action} staging cannot affect newly selected B`, async ({
    page,
  }) => {
    await setup(page);
    const before = await rawState(page);
    const expectedB = await page.evaluate(async () => {
      const { openSavedMachineStore } = await import("/saved-machine-store.js");
      const { CpmDisk } = await import("/triptych_host_wasm.js");
      const store = await openSavedMachineStore();
      let disk;
      try {
        const head = await store.load();
        disk = new CpmDisk(head.snapshot.drives.B.bytes);
        disk.add_import(
          "SAFE.TXT",
          new TextEncoder().encode("explicit B action\r\n"),
        );
        return Array.from(
          new Uint8Array(
            await crypto.subtle.digest("SHA-256", disk.export_candidate()),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
      } finally {
        disk?.free();
        store.close();
      }
    });
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    if (action === "tool") {
      await page.route("**/tool-nucleus-*.com", async (route) => {
        started();
        await gate;
        await route.continue();
      });
      await page
        .locator("#tool-list li")
        .filter({ hasText: "NUC.COM" })
        .getByRole("button")
        .click();
      await entered;
    } else {
      await page.evaluate(() => {
        const read = File.prototype.arrayBuffer;
        window.delayedReadStarted = false;
        File.prototype.arrayBuffer = async function () {
          if (this.name === "DELAY.TXT" || this.name === "delay.img") {
            window.delayedReadStarted = true;
            await new Promise((resolve) => {
              window.releaseDelayedRead = resolve;
            });
          }
          return read.call(this);
        };
      });
      await page
        .locator(action === "file" ? "#file-import" : "#disk-input")
        .setInputFiles({
          name: action === "file" ? "DELAY.TXT" : "delay.img",
          mimeType: "application/octet-stream",
          buffer:
            action === "file"
              ? Buffer.from("must not reach B")
              : Buffer.alloc(8388608, 0x5a),
        });
      await expect
        .poll(() => page.evaluate(() => window.delayedReadStarted))
        .toBe(true);
    }
    await page.locator("#file-drive").selectOption("B");
    await expect(page.locator("#disk-summary")).toContainText("Drive B:");
    if (action === "tool") release();
    else await page.evaluate(() => window.releaseDelayedRead());
    await expect(page.locator("#files-status")).toContainText("superseded");
    await expect(page.locator("#commit-disk")).toBeDisabled();
    expect(await rawState(page)).toEqual(before);
    // Prove the surviving B selection remains usable and the rejected request
    // has not left a hidden A or B candidate behind the next successful stage.
    await page.locator("#file-import").setInputFiles({
      name: "SAFE.TXT",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("explicit B action\r\n"),
    });
    await expect(page.locator("#files-status")).toContainText(
      "Staged SAFE.TXT",
    );
    await apply(page);
    const after = await rawState(page);
    expect(after.images.A).toEqual(before.images.A);
    expect(after.images.bootstrap).toEqual(before.images.bootstrap);
    expect(after.images.B.hash).toBe(expectedB);
    await expect(page.locator("#file-list")).toContainText("SAFE.TXT");
    await expect(page.locator("#file-list")).not.toContainText("DELAY.TXT");
    await expect(page.locator("#file-list")).not.toContainText("NUC.COM");
  });
}
