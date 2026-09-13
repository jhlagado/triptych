import { expect, test } from "@playwright/test";
import { seedLegacyDisk, adoptHistoricalMachine } from "./legacy-fixture.mjs";

async function state(page, name = "triptych-cpu") {
  return page.evaluate(async (name) => {
    if (!(await indexedDB.databases()).some((db) => db.name === name))
      return null;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      if (!db.objectStoreNames.contains("disk-box-state-v1")) return null;
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(["disk-box-state-v1", "disk-box-blobs-v1"]);
        const head = tx.objectStore("disk-box-state-v1").get("head");
        const blobs = tx.objectStore("disk-box-blobs-v1").getAllKeys();
        tx.oncomplete = () =>
          resolve(
            head.result
              ? {
                  revision: head.result.revision,
                  digest: head.result.digest,
                  manifest: head.result.manifest,
                  blobs: blobs.result,
                }
              : null,
          );
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, name);
}
async function historicalState(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-cpu");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction("working-disks");
        const request = tx.objectStore("working-disks").get("drive-a");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const bytes = new Uint8Array(row.bytes);
      const digest = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        schema: row.schema,
        key: row.key,
        name: row.name,
        byteLength: bytes.length,
        digest,
      };
    } finally {
      db.close();
    }
  });
}
async function library(page) {
  if (
    !(await page.locator("#disk-library").evaluate((element) => element.open))
  )
    await page.locator("#disk-library > summary").click();
  await expect(page.locator("#saved-configuration option")).not.toHaveCount(0);
}

test("an adopted configuration remains selectable and its local bookmark reopens it after a recipe switch", async ({
  page,
}) => {
  test.setTimeout(120000);
  page.on("dialog", (dialog) => dialog.accept());
  await seedLegacyDisk(page);
  await adoptHistoricalMachine(page);
  await expect(page.locator("#terminal")).toContainText("A>");
  const adopted = await state(page),
    originalId = adopted.manifest.selectedConfigurationId;
  await library(page);
  await page.locator("#library-ready").check();
  await page.locator("#launch-starter").click();
  await expect
    .poll(async () => (await state(page)).manifest.configurations.length)
    .toBe(2);
  const launched = await state(page),
    recipeId = launched.manifest.selectedConfigurationId;
  expect(recipeId).not.toBe(originalId);
  await expect(
    page.locator(`#saved-configuration option[value="${originalId}"]`),
  ).toContainText("My saved machine");
  await page.locator("#saved-configuration").selectOption(originalId);
  const bookmark = await page
    .locator("#local-configuration-bookmark")
    .getAttribute("href");
  expect(bookmark).toBe(`?configuration=${originalId}`);
  await expect(page.locator("#local-configuration-bookmark")).toContainText(
    "not shareable",
  );
  expect(
    await page.locator("#share-starter").getAttribute("href"),
  ).not.toContain(originalId);
  await page.locator("#library-ready").check();
  await page.locator("#activate-configuration").click();
  await expect
    .poll(async () => (await state(page)).manifest.selectedConfigurationId)
    .toBe(originalId);
  await page.locator("#saved-configuration").selectOption(recipeId);
  await page.locator("#library-ready").check();
  await page.locator("#activate-configuration").click();
  await expect
    .poll(async () => (await state(page)).manifest.selectedConfigurationId)
    .toBe(recipeId);
  await page.goto(bookmark);
  await expect(page.locator("#terminal")).toContainText("A>");
  const reopened = await state(page);
  expect(reopened.manifest.selectedConfigurationId).toBe(originalId);
  expect(reopened.manifest.configurations).toEqual(
    launched.manifest.configurations,
  );
  expect(reopened.manifest.personalDisks).toEqual(
    launched.manifest.personalDisks,
  );
  expect(reopened.blobs).toEqual(launched.blobs);
});

test("a missing local bookmark waits for exact selection without booting or publishing", async ({
  page,
}) => {
  test.setTimeout(120000);
  await seedLegacyDisk(page);
  const historicalBefore = await historicalState(page);
  const missingId = "00000000-0000-4000-8000-000000000099";

  await page.goto(`/?configuration=${missingId}`);
  await expect(page.locator("#adopt-disks")).toBeVisible();
  await expect(page.locator("#local-configuration-resolution")).toBeHidden();
  expect(await state(page)).toBeNull();
  expect(await historicalState(page)).toEqual(historicalBefore);
  expect((await page.locator("#terminal").textContent()).includes("A>")).toBe(
    false,
  );

  await page.locator("#adopt-disks").click();
  await expect(page.locator("#local-configuration-resolution")).toBeVisible();
  await expect(page.locator("#local-configuration-choice option")).toHaveCount(
    1,
  );
  const before = await state(page);
  const targetId = before.manifest.selectedConfigurationId;
  expect((await page.locator("#terminal").textContent()).includes("A>")).toBe(
    false,
  );
  expect(await historicalState(page)).toEqual(historicalBefore);

  await page.locator("#local-configuration-choice").selectOption(targetId);
  await page.locator("#resolve-local-configuration").click();
  await expect(page.locator("#terminal")).toContainText("A>");
  expect(new URL(page.url()).search).toBe(`?configuration=${targetId}`);
  const after = await state(page);
  expect(after).toEqual(before);
  expect(await historicalState(page)).toEqual(historicalBefore);
});

test("creating after historical adoption retains the adopted setup and starts one independent setup", async ({
  page,
}) => {
  test.setTimeout(120000);
  await seedLegacyDisk(page);
  const historicalBefore = await historicalState(page);
  const missingId = "00000000-0000-4000-8000-000000000097";

  await page.goto(`/?configuration=${missingId}`);
  await page.evaluate(async () => {
    const { TriptychCpu } = await import("/triptych_host_wasm.js");
    const original = TriptychCpu.prototype.free;
    window.__triptychTestFreeCount = 0;
    TriptychCpu.prototype.free = function (...args) {
      window.__triptychTestFreeCount += 1;
      return original.apply(this, args);
    };
  });
  await page.locator("#adopt-disks").click();
  await expect(page.locator("#local-configuration-resolution")).toBeVisible();
  const adopted = await state(page);
  const adoptedId = adopted.manifest.selectedConfigurationId;

  await page.locator("#create-local-configuration").click();
  await expect(page.locator("#terminal")).toContainText("A>");
  const created = await state(page);
  expect(created.manifest.configurations).toHaveLength(2);
  expect(
    created.manifest.configurations.some((item) => item.id === adoptedId),
  ).toBe(true);
  expect(created.manifest.selectedConfigurationId).not.toBe(adoptedId);
  expect(await page.evaluate(() => window.__triptychTestFreeCount)).toBe(1);
  expect(await historicalState(page)).toEqual(historicalBefore);
});

test("an unbootable saved choice stays in the resolver and leaves the current setup selected", async ({
  page,
}) => {
  test.setTimeout(120000);
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  const original = await state(page);
  const originalId = original.manifest.selectedConfigurationId;

  await library(page);
  await page.locator("#library-ready").check();
  await page.locator("#launch-fresh").click();
  await expect
    .poll(async () => (await state(page)).manifest.configurations.length)
    .toBe(2);
  const independentId = (await state(page)).manifest.selectedConfigurationId;

  await page.locator("#library-slot").selectOption("0");
  await page.locator("#library-ready").check();
  await page.locator("#library-eject").click();
  await expect
    .poll(() =>
      state(page).then(
        (saved) =>
          saved.manifest.configurations.find(
            (item) => item.id === saved.manifest.selectedConfigurationId,
          ).slots[0],
      ),
    )
    .toBeNull();

  await page.goto(`/?configuration=${originalId}`);
  await expect(page.locator("#terminal")).toContainText("A>");
  expect((await state(page)).manifest.selectedConfigurationId).toBe(originalId);

  const missingId = "00000000-0000-4000-8000-000000000096";
  await page.goto(`/?configuration=${missingId}`);
  await expect(page.locator("#local-configuration-resolution")).toBeVisible();
  await page.locator("#local-configuration-choice").selectOption(independentId);
  await page.locator("#resolve-local-configuration").click();

  await expect(page.locator("#local-configuration-resolution")).toBeVisible();
  await expect(
    page.locator("#local-configuration-resolution-message"),
  ).toContainText("retained system disk");
  await expect(page.locator("#resolve-local-configuration")).toBeEnabled();
  expect((await state(page)).manifest.selectedConfigurationId).toBe(originalId);
  await expect(page.locator("#restore-system-disk")).toBeHidden();
});

test("explicit fresh resolution creates one independent starter in only the supplied namespace", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  const defaultBefore = await state(page);
  const missingId = "00000000-0000-4000-8000-000000000098";

  await page.goto(`/?machine=supplied&configuration=${missingId}`);
  await expect(page.locator("#local-configuration-resolution")).toBeVisible();
  await expect(page.locator("#resolve-local-configuration")).toBeDisabled();
  expect(await state(page, "triptych-supplied")).toBeNull();
  expect(await state(page)).toEqual(defaultBefore);
  expect((await page.locator("#terminal").textContent()).includes("A>")).toBe(
    false,
  );

  await page.locator("#create-local-configuration").click();
  await expect(page.locator("#terminal")).toContainText("A>");
  const supplied = await state(page, "triptych-supplied");
  expect(supplied.manifest.configurations).toHaveLength(1);
  expect(supplied.manifest.launchInstances).toHaveLength(1);
  expect(supplied.manifest.personalDisks).toHaveLength(2);
  expect(supplied.manifest.selectedConfigurationId).not.toBe(missingId);
  expect(new URL(page.url()).search).toBe(
    `?machine=supplied&configuration=${supplied.manifest.selectedConfigurationId}`,
  );
  expect(await state(page)).toEqual(defaultBefore);
});

test("a configuration display name is never accepted as a local identity", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  const before = await state(page);
  const displayName = before.manifest.configurations[0].name;
  await page.goto(`/?configuration=${encodeURIComponent(displayName)}`);
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toContainText(
    "Invalid device-local configuration identifier",
  );
  await expect(page.locator("#local-configuration-resolution")).toBeHidden();
  expect(await state(page)).toEqual(before);
});

test("combined public and local selectors reject without creating a disk-box head", async ({
  page,
}) => {
  await page.goto(
    "/?configuration=00000000-0000-4000-8000-000000000001&recipe=starter&revision=unknown",
  );
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await expect(page.locator("#status")).toContainText("not both");
  expect(await state(page)).toBeNull();
});
