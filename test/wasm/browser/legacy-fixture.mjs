import { expect, test as base } from "@playwright/test";

export { expect };

// Historical migration/recovery scenarios intentionally start from the old
// one-drive distribution. Public-default acceptance imports Playwright directly.
export async function useLegacyConfiguration(page) {
  const handler = (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        diskUrl: "cpm22.img",
        diskName: "triptych-cpm22.img",
        systemCcp: "triptych",
      }),
    });
  await page.route("**/config.json", handler);
  return async () => {
    if (!page.isClosed()) await page.unroute("**/config.json", handler);
  };
}

export const test = base.extend({
  legacyConfiguration: [
    async ({ page }, use) => {
      const removeRoute = await useLegacyConfiguration(page);
      await use();
      await removeRoute();
    },
    { auto: true },
  ],
});
