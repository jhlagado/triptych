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
              ? { manifest: head.result.manifest, blobs: blobs.result }
              : null,
          );
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  }, name);
}
async function library(page) {
  if (
    !(await page.locator("#disk-library").evaluate((element) => element.open))
  )
    await page.locator("#disk-library summary").click();
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

test("supplied local bookmarks preserve their namespace and never initialize a missing configuration elsewhere", async ({
  page,
  browser,
}) => {
  await page.goto("/?machine=supplied");
  await expect(page.locator("#terminal")).toContainText("A>");
  await library(page);
  const before = await state(page, "triptych-supplied");
  const bookmark = await page
    .locator("#local-configuration-bookmark")
    .getAttribute("href");
  expect(bookmark).toBe(
    `?machine=supplied&configuration=${before.manifest.selectedConfigurationId}`,
  );
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await other.goto(new URL(bookmark, page.url()).href);
    await expect(other.locator("#status")).toHaveAttribute(
      "data-state",
      "error",
    );
    await expect(other.locator("#status")).toContainText(
      "Device-local configuration not found",
    );
    await expect(other.locator("#adopt-disks")).toBeHidden();
    expect(await state(other, "triptych-supplied")).toBeNull();
    expect(await state(other, "triptych-cpu")).toBeNull();
    expect(
      (await other.locator("#terminal").textContent()).includes("A>"),
    ).toBe(false);
  } finally {
    await context.close();
  }
  expect(await state(page, "triptych-supplied")).toEqual(before);
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
