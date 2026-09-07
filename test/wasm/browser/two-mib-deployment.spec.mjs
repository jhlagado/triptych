import { expect, test } from "@playwright/test";
import { checkServedTwoMibAssets } from "../../../tools/lib/served-two-mib-assets.mjs";

test.beforeEach(async ({ page }) => {
  // Only the empty host page is synthetic. Every module and binary below is
  // served from the actual coordinated build, with no app/storage activation.
  await page.route("**/two-mib-assets-check", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/two-mib-assets-check");
});

async function manifest(request) {
  const response = await request.get("/deployment-manifest.json");
  expect(response.ok()).toBe(true);
  return response.json();
}

test("staged n01/n16 modules and binaries load through their real served paths", async ({
  page,
  request,
  baseURL,
}) => {
  await checkServedTwoMibAssets(page, `${baseURL}/`, await manifest(request));
});

test("served-module qualification rejects a missing transitive dependency", async ({
  page,
  request,
  baseURL,
}) => {
  await page.route("**/drive-set-v4.js", (route) => route.abort());
  await expect(
    checkServedTwoMibAssets(page, `${baseURL}/`, await manifest(request)),
  ).rejects.toThrow();
});

test("served-module qualification rejects a corrupted n16 bootstrap", async ({
  page,
  request,
  baseURL,
}) => {
  await page.route("**/bootstrap-triptych-cpm-2m-n16-v1.bin", (route) =>
    route.fulfill({
      contentType: "application/octet-stream",
      body: Buffer.alloc(256),
    }),
  );
  await expect(
    checkServedTwoMibAssets(page, `${baseURL}/`, await manifest(request)),
  ).rejects.toThrow(/digest differs/);
});
