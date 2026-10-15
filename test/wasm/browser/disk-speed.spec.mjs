import { expect, test } from "@playwright/test";

async function prompt(page) {
  await expect
    .poll(async () => /A>/.test(await page.locator("#terminal").textContent()))
    .toBe(true);
}

test("floppy disk speed paces a cold boot and persists per browser", async ({
  page,
}) => {
  await page.goto("/");
  await prompt(page);
  await expect(page.locator("#disk-speed")).toHaveValue("");
  await expect(page.locator("#disk-timing-status")).toBeHidden();

  await page.selectOption("#disk-speed", "5in-dsdd");
  const status = page.locator("#disk-timing-status");
  await expect(status).toBeVisible();
  await expect(status).toContainText("5¼″ floppy at 4 MHz");

  // The modelled 5.25-inch cold boot takes about five seconds of disk time;
  // instant media boots in a fraction of a second.
  const started = Date.now();
  await page.click("#reset");
  await prompt(page);
  expect(Date.now() - started).toBeGreaterThan(3_000);
  await expect(status).toContainText(/[1-9]\d* reads/);

  await page.reload();
  await prompt(page);
  await expect(page.locator("#disk-speed")).toHaveValue("5in-dsdd");
  await expect(status).toBeVisible();

  await page.selectOption("#disk-speed", "");
  await expect(status).toBeHidden();
  const instant = Date.now();
  await page.click("#reset");
  await prompt(page);
  expect(Date.now() - instant).toBeLessThan(3_000);
});
