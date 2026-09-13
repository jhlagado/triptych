import { expect, test } from "@playwright/test";

async function boot(page, path) {
  await page.goto(path);
  await expect(page.locator("#terminal")).toContainText("A>");
}

async function databases(page) {
  return page.evaluate(async () =>
    (await indexedDB.databases()).map((entry) => entry.name).sort(),
  );
}

test("Start fresh removes every Triptych database and boots the published system", async ({
  page,
}) => {
  await boot(page, "/?machine=supplied");
  await boot(page, "/");
  await expect
    .poll(() => databases(page))
    .toEqual(["triptych-cpu", "triptych-supplied"]);

  await page.locator("#open-library").click();
  await page.locator("#library-name").fill("Erase proof");
  await page.locator("#library-blank").click();
  await expect(page.locator("#personal-disk-list")).toContainText(
    "Erase proof",
  );
  await page.getByText("Backup and recovery", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await Promise.all([
    page.waitForNavigation(),
    page.locator("#erase-triptych-data").click(),
  ]);

  await expect(page.locator("#terminal")).toContainText("A>");
  await expect.poll(() => databases(page)).toEqual(["triptych-cpu"]);
  await page.locator("#open-library").click();
  await expect(page.locator("#personal-disk-list")).not.toContainText(
    "Erase proof",
  );
});

test("a non-owning tab cannot erase an owning tab's saved machines", async ({
  context,
  page: owner,
}) => {
  await boot(owner, "/");
  const peer = await context.newPage();
  await boot(peer, "/");
  await expect(peer.locator("#save-status")).toContainText("Read-only tab");

  await peer.locator("#open-library").click();
  await peer.getByText("Backup and recovery", { exact: true }).click();
  peer.once("dialog", (dialog) => dialog.accept());
  await peer.locator("#erase-triptych-data").click();

  await expect(peer.locator("#library-status")).toContainText(
    "tab that owns this machine",
  );
  await expect.poll(() => databases(peer)).toContain("triptych-cpu");
  await expect(owner.locator("#terminal")).toContainText("A>");
  await owner.locator("#terminal").pressSequentially("DIR", { delay: 10 });
  await owner.locator("#terminal").press("Enter");
  await expect(owner.locator("#terminal")).toContainText("ATOM");
});

test("Start fresh refuses while the other saved machine is open", async ({
  context,
  page,
}) => {
  await boot(page, "/");
  const supplied = await context.newPage();
  await boot(supplied, "/?machine=supplied");

  await page.locator("#open-library").click();
  await page.getByText("Backup and recovery", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#erase-triptych-data").click();

  await expect(page.locator("#library-status")).toContainText(
    "Close every other Triptych tab",
  );
  await expect
    .poll(() => databases(page))
    .toEqual(["triptych-cpu", "triptych-supplied"]);
  await expect(page.locator("#close-library")).toBeEnabled();
  await expect(supplied.locator("#terminal")).toContainText("A>");
});

test("an interrupted partial wipe finishes on the next visit", async ({
  context,
  page,
}) => {
  await boot(page, "/?machine=supplied");
  await boot(page, "/");
  const blocker = await context.newPage();
  await blocker.goto("/favicon.svg");
  await blocker.evaluate(async () => {
    window.blockedDatabase = await new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-supplied");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  });

  await page.locator("#open-library").click();
  await page.getByText("Backup and recovery", { exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#erase-triptych-data").click();
  await expect(page.locator("#library-status")).toContainText(
    "Waiting for another Triptych tab",
  );
  await expect.poll(() => databases(blocker)).toEqual(["triptych-supplied"]);
  expect(
    await blocker.evaluate(() =>
      localStorage.getItem("triptych:start-fresh-in-progress:v1"),
    ),
  ).toBe("yes");

  await page.close();
  await blocker.evaluate(() => window.blockedDatabase.close());
  await blocker.close();
  const resumed = await context.newPage();
  await boot(resumed, "/");
  await expect.poll(() => databases(resumed)).toEqual(["triptych-cpu"]);
  expect(
    await resumed.evaluate(() =>
      localStorage.getItem("triptych:start-fresh-in-progress:v1"),
    ),
  ).toBeNull();
});
