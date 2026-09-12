import { expect, test } from "@playwright/test";
import { openDownloads } from "./downloads-fixture.mjs";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`compact toolbar keeps the terminal visible at ${viewport.width}px and expands real download controls`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect(page.locator("#terminal")).toContainText("A>");
    const section = page.locator("#downloads-recovery");
    expect(await section.evaluate((element) => element.open)).toBe(false);
    await expect(page.locator("header button:visible")).toHaveText([
      "Files",
      "Reset",
    ]);
    for (const id of [
      "download",
      "download-recovery",
      "download-set",
      "download-checkpoint-set",
      "legacy-recovery",
      "raw-recovery",
    ]) {
      await expect(section.locator(`#${id}`)).toHaveCount(1);
      await expect(section.locator(`#${id}`)).toBeHidden();
    }
    // Focus during boot may scroll the page. Inspect the toolbar from the top,
    // using a real scrolling action before measuring its viewport footprint.
    await page.locator("h1").scrollIntoViewIfNeeded();
    const header = await page.locator("header").boundingBox(),
      terminal = await page.locator("#terminal").boundingBox();
    expect(header.height).toBeLessThan(130);
    expect(terminal.y).toBeLessThan(viewport.height / 2);
    expect(
      Math.min(terminal.y + terminal.height, viewport.height) -
        Math.max(terminal.y, 0),
    ).toBeGreaterThan(viewport.height / 4);
    await openDownloads(page);
    await openDownloads(page); // The shared helper is idempotent.
    expect(await section.evaluate((element) => element.open)).toBe(true);
    for (const id of [
      "download",
      "download-recovery",
      "download-set",
      "download-checkpoint-set",
    ])
      await expect(section.locator(`#${id}`)).toBeVisible();
    const pending = page.waitForEvent("download");
    await section.locator("#download-set").click();
    expect((await pending).suggestedFilename()).toMatch(/\.tds$/);
    await section.getByText("Downloads and recovery", { exact: true }).click();
    await expect(section.locator("#download-set")).toBeHidden();
  });
}
