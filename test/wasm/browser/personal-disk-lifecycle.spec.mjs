import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function diskBoxState(page, diskId) {
  return page.evaluate(async (diskId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-cpu");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const stored = await new Promise((resolve, reject) => {
        const transaction = db.transaction([
          "disk-box-state-v1",
          "disk-box-blobs-v1",
        ]);
        const head = transaction.objectStore("disk-box-state-v1").get("head");
        let content;
        head.onsuccess = () => {
          const disk = head.result?.manifest.personalDisks.find(
            (item) => item.id === diskId,
          );
          if (disk)
            content = transaction
              .objectStore("disk-box-blobs-v1")
              .get(disk.content.sha256);
        };
        transaction.oncomplete = () =>
          resolve({
            manifest: head.result.manifest,
            bytes: content?.result?.bytes,
          });
        transaction.onabort = () => reject(transaction.error);
      });
      return {
        manifest: stored.manifest,
        actual:
          stored.bytes === undefined
            ? undefined
            : {
                byteLength: stored.bytes.byteLength,
                sha256: Array.from(
                  new Uint8Array(
                    await crypto.subtle.digest("SHA-256", stored.bytes),
                  ),
                  (byte) => byte.toString(16).padStart(2, "0"),
                ).join(""),
              },
      };
    } finally {
      db.close();
    }
  }, diskId);
}

const selected = (state) =>
  state.manifest.configurations.find(
    (configuration) =>
      configuration.id === state.manifest.selectedConfigurationId,
  );

async function downloadDisk(row, page, path) {
  const pending = page.waitForEvent("download");
  await row.getByRole("button", { name: "Download", exact: true }).click();
  const download = await pending;
  await download.saveAs(path);
  return download.suggestedFilename();
}

test("personal image import, rename, download and cross-slot reload preserve exact written bytes", async ({
  page,
  request,
}, testInfo) => {
  const registryResponse = await request.get("/disk-library-registry.json");
  expect(registryResponse.ok()).toBe(true);
  const registry = await registryResponse.json();
  const starterReference = registry.defaults.find(
    (reference) => reference.id === "starter",
  );
  expect(starterReference).toBeTruthy();
  const starter = registry.recipes.find(
    (recipe) =>
      recipe.id === starterReference.id &&
      recipe.revision === starterReference.revision,
  );
  expect(starter).toBeTruthy();
  const seedAsset = starter.slots.find((slot) => slot?.kind === "writable-role")
    .seed.asset;
  const seedResponse = await request.get(`/${seedAsset}`);
  expect(seedResponse.ok()).toBe(true);
  const seed = Buffer.from(await seedResponse.body());
  expect(seed).toHaveLength(2097152);

  await page.goto("/");
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent()).trimEnd().endsWith("A>"),
    )
    .toBe(true);
  await page.locator("#disk-library > summary").click();

  const initial = await diskBoxState(page);
  const initialIds = initial.manifest.personalDisks.map((disk) => disk.id);
  expect(initialIds).toHaveLength(2);

  await page.locator("#library-name").fill("Imported stage three");
  await page.locator("#library-ready").check();
  await page.locator("#library-import").setInputFiles({
    name: "stage-three.img",
    mimeType: "application/octet-stream",
    buffer: seed,
  });
  const importedRow = page
    .locator("#personal-disk-list li")
    .filter({ hasText: "Imported stage three" });
  await expect(importedRow).toHaveCount(1);
  await expect(importedRow).toContainText("ejected");

  const importedState = await diskBoxState(page);
  const imported = importedState.manifest.personalDisks.find(
    (disk) => !initialIds.includes(disk.id),
  );
  expect(imported).toMatchObject({
    name: "Imported stage three",
    geometry: "triptych-cpm-2m-v1",
    content: { byteLength: seed.length, sha256: hash(seed) },
  });
  expect(importedState.manifest.personalDisks).toHaveLength(3);

  const renamed = "Renamed stage three";
  await page.locator("#library-ready").check();
  page.once("dialog", (dialog) => void dialog.accept(renamed));
  await importedRow
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  const renamedRow = page
    .locator(`[data-disk-id="${imported.id}"]`)
    .filter({ hasText: renamed });
  await expect(renamedRow).toHaveCount(1);
  expect(
    (await diskBoxState(page)).manifest.personalDisks.find(
      (disk) => disk.id === imported.id,
    ).name,
  ).toBe(renamed);

  await page.locator("#library-slot").selectOption("1");
  await page.locator("#library-ready").check();
  await renamedRow.getByRole("button", { name: "Insert", exact: true }).click();
  await expect
    .poll(async () => selected(await diskBoxState(page)).slots[1]?.diskId)
    .toBe(imported.id);

  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#files-status")).toContainText("CPU paused");
  await page.locator("#file-drive").selectOption("B");
  await expect(page.locator("#file-import")).toBeEnabled();
  await page.locator("#file-import").setInputFiles({
    name: "PROOF.TXT",
    mimeType: "text/plain",
    buffer: Buffer.from("STAGE-3-PERSONAL-DISK-PERSISTENCE\r\n"),
  });
  await expect(page.locator("#files-status")).toContainText("Staged PROOF.TXT");
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await expect(
    page.locator("#file-list li").filter({ hasText: "PROOF.COM" }),
  ).toHaveCount(0);
  await expect(
    page.locator("#file-list li").filter({ hasText: "PROOF.TXT" }),
  ).toHaveCount(1);
  await page.locator("#close-files").click();

  const written = await diskBoxState(page, imported.id);
  const writtenDisk = written.manifest.personalDisks.find(
    (disk) => disk.id === imported.id,
  );
  expect(writtenDisk.content.sha256).not.toBe(hash(seed));
  expect(written.actual).toEqual(writtenDisk.content);

  const beforeReloadPath = testInfo.outputPath("personal-before-reload.img");
  expect(await downloadDisk(renamedRow, page, beforeReloadPath)).toBe(
    `${renamed}.img`,
  );
  const beforeReload = await readFile(beforeReloadPath);
  expect(beforeReload).toHaveLength(seed.length);
  expect(hash(beforeReload)).toBe(writtenDisk.content.sha256);

  await page.locator("#library-slot").selectOption("1");
  await page.locator("#library-ready").check();
  await page.locator("#library-eject").click();
  await expect
    .poll(async () => selected(await diskBoxState(page)).slots[1])
    .toBeNull();

  await page.locator("#library-slot").selectOption("3");
  await page.locator("#library-ready").check();
  await renamedRow.getByRole("button", { name: "Insert", exact: true }).click();
  await expect
    .poll(async () => selected(await diskBoxState(page)).slots[3]?.diskId)
    .toBe(imported.id);

  const beforeReloadState = await diskBoxState(page, imported.id);
  await page.reload();
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent()).trimEnd().endsWith("A>"),
    )
    .toBe(true);
  await page.locator("#disk-library > summary").click();
  const afterReload = await diskBoxState(page, imported.id);
  expect(afterReload).toEqual(beforeReloadState);
  expect(selected(afterReload).slots[1]).toBeNull();
  expect(selected(afterReload).slots[3]?.diskId).toBe(imported.id);
  expect(
    afterReload.manifest.personalDisks.map((disk) => disk.id).sort(),
  ).toEqual([...initialIds, imported.id].sort());

  const restoredRow = page.locator(`[data-disk-id="${imported.id}"]`);
  await expect(restoredRow).toContainText(renamed);
  await expect(restoredRow).toContainText("D");
  const afterReloadPath = testInfo.outputPath("personal-after-reload.img");
  expect(await downloadDisk(restoredRow, page, afterReloadPath)).toBe(
    `${renamed}.img`,
  );
  expect(await readFile(afterReloadPath)).toEqual(beforeReload);
});
