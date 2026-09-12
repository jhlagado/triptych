import { expect, test } from "./legacy-fixture.mjs";
import { fileURLToPath } from "node:url";

test.beforeEach(async ({ context }) => {
  // Isolate ownership tests from the live app's database and CPU lifecycle.
  await context.route("**/ownership-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Disk ownership</title>",
    }),
  );
  await context.route("**/disk-workspace.js", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      path: fileURLToPath(
        new URL(
          "../../../crates/triptych-host-wasm/web/disk-workspace.js",
          import.meta.url,
        ),
      ),
    }),
  );
});

async function acquire(page, name) {
  return page.evaluate(async (name) => {
    const { acquireDiskWriter } = await import("/disk-workspace.js");
    window.diskWriter = await acquireDiskWriter({ name });
    return window.diskWriter.owned;
  }, name);
}

test("only one tab can own disk writes, and explicit release permits another", async ({
  context,
  page,
}) => {
  const other = await context.newPage();
  await Promise.all([
    page.goto("/ownership-test"),
    other.goto("/ownership-test"),
  ]);
  const name = "triptych-test:exclusive";
  expect(await acquire(page, name)).toBe(true);
  expect(await acquire(other, name)).toBe(false);
  await page.evaluate(async () => {
    await window.diskWriter.release();
    await window.diskWriter.release();
  });
  expect(await page.evaluate(() => window.diskWriter.owned)).toBe(false);
  expect(await acquire(other, name)).toBe(true);
  expect(await acquire(page, name)).toBe(false);
  await other.evaluate(() => window.diskWriter.release());
});

test("closing an owning tab releases its actual browser lock", async ({
  context,
  page,
}) => {
  const other = await context.newPage();
  await Promise.all([
    page.goto("/ownership-test"),
    other.goto("/ownership-test"),
  ]);
  const name = "triptych-test:closed-owner";
  expect(await acquire(page, name)).toBe(true);
  expect(await acquire(other, name)).toBe(false);
  await page.close();
  await expect.poll(() => acquire(other, name)).toBe(true);
  await other.evaluate(() => window.diskWriter.release());
});

test("missing or denied lock support gives a non-writable lease", async ({
  page,
}) => {
  await page.goto("/ownership-test");
  const states = await page.evaluate(async () => {
    const { acquireDiskWriter } = await import("/disk-workspace.js");
    const absent = await acquireDiskWriter({ locks: null });
    const denied = await acquireDiskWriter({
      locks: {
        request() {
          return Promise.reject(new DOMException("Denied", "SecurityError"));
        },
      },
    });
    const result = [absent.owned, denied.owned];
    await absent.release();
    await denied.release();
    return result;
  });
  expect(states).toEqual([false, false]);
});
