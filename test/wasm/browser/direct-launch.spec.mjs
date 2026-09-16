import { expect, test } from "@playwright/test";

async function prompt(page, suffix = "A>") {
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent())
        .trimEnd()
        .endsWith(suffix),
    )
    .toBe(true);
}

async function command(page, text, suffix) {
  const terminal = page.locator("#terminal");
  const before = await terminal.textContent();
  await terminal.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const after = await terminal.textContent();
      return after !== before && after.trimEnd().endsWith(suffix);
    })
    .toBe(true);
  return terminal.textContent();
}

const triptychDatabases = (page) =>
  page.evaluate(async () =>
    (await indexedDB.databases())
      .map((database) => database.name)
      .filter((name) => name?.startsWith("triptych")),
  );

test("games on A run in a second tab alongside Advent", async ({
  page,
  context,
}) => {
  await page.goto("/?disk=advent");
  await prompt(page);
  const games = await context.newPage();
  await games.goto("/?disk=games");
  await prompt(games);
  const listing = await command(games, "DIR", "A>");
  for (const name of ["CAVERNS", "HYPERDRV", "HYPERD2"])
    expect(listing).toContain(name);
  for (const name of ["CAVERNS", "HYPERDRV", "HYPERD2"]) {
    await games.locator("#reset").click();
    await prompt(games);
    await command(
      games,
      name,
      name === "HYPERDRV" ? "?" : "[Space/Enter: more, Q: skip]",
    );
  }
  await command(page, "ADVENT", "WOULD YOU LIKE INSTRUCTIONS?");
  expect(await triptychDatabases(games)).toEqual(["triptych-direct-b-v1"]);
  await expect(games.locator("#status")).toContainText(
    "B1 is read-only because another tab owns it.",
  );
  await expect(games.locator("#files")).toBeHidden();
  await expect(games.locator("#open-library")).toBeHidden();
});

test("the Advent link boots drive A with a persistent B1", async ({ page }) => {
  await page.goto("/?disk=advent");
  await prompt(page);
  await expect(page).toHaveTitle("Colossal Cave Adventure — Triptych");
  await expect(page.locator("#status")).toHaveText(
    "Colossal Cave is in drive A. Type ADVENT. B1 is persistent and writable.",
  );
  await expect(page.locator("#open-library")).toBeHidden();
  await expect(page.locator("#files")).toBeHidden();
  expect(await triptychDatabases(page)).toEqual(["triptych-direct-b-v1"]);

  const listing = await command(page, "DIR", "A>");
  expect(listing).toContain("ADVENT");
  expect(listing).toContain("PHROGZ");
  expect(listing).not.toContain("ADVENTUR");
  await command(page, "SAVE 1 DENIED.COM", "Bdos Err On A: Bad Sector");
  await page.locator("#reset").click();
  await prompt(page);
  await command(page, "ADVENT", "WOULD YOU LIKE INSTRUCTIONS?");
  expect(await triptychDatabases(page)).toEqual(["triptych-direct-b-v1"]);

  await page.reload();
  await prompt(page);
  expect(await triptychDatabases(page)).toEqual(["triptych-direct-b-v1"]);
  const afterReload = await command(page, "DIR", "A>");
  expect(afterReload).toContain("ADVENT");
  expect(afterReload).toContain("PHROGZ");
});

async function directGeneration(page, slot) {
  return page.evaluate(async (slot) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-direct-b-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("slots", "readonly");
        const request = transaction.objectStore("slots").get(slot);
        request.onsuccess = () => resolve(request.result?.generation ?? 0);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }, slot);
}

test("direct demos share B1 and auto allocation selects a persistent B2", async ({
  page,
  context,
}) => {
  await page.goto("/?disk=advent");
  await prompt(page);
  await command(page, "B:", "B>");
  await command(page, "SAVE 1 WORK.COM", "B>");
  expect(await command(page, "DIR", "B>")).toContain("WORK");
  await expect.poll(() => directGeneration(page, 1)).toBeGreaterThan(1);

  const shared = await context.newPage();
  await shared.goto("/?disk=games");
  await prompt(shared);
  await expect(shared.locator("#status")).toContainText(
    "B1 is read-only because another tab owns it.",
  );
  await command(shared, "B:", "B>");
  expect(await command(shared, "DIR", "B>")).toContain("WORK");

  const auto = await context.newPage();
  await auto.goto("/?disk=games&b=auto");
  await prompt(auto);
  await expect(auto.locator("#status")).toContainText(
    "B2 is persistent and writable.",
  );
  expect(new URL(auto.url()).searchParams.get("b")).toBe("B2");
  await command(auto, "B:", "B>");
  expect(await command(auto, "DIR", "B>")).toContain("NO FILE");
  await command(auto, "SAVE 1 AUTO.COM", "B>");
  expect(await command(auto, "DIR", "B>")).toContain("AUTO");
  await expect.poll(() => directGeneration(auto, 2)).toBeGreaterThan(1);

  const explicit = await context.newPage();
  await explicit.goto("/?disk=advent&b=B2");
  await prompt(explicit);
  await expect(explicit.locator("#status")).toContainText(
    "B2 is read-only because another tab owns it.",
  );
  await command(explicit, "B:", "B>");
  expect(await command(explicit, "DIR", "B>")).toContain("AUTO");

  await page.reload();
  await prompt(page);
  await command(page, "B:", "B>");
  expect(await command(page, "DIR", "B>")).toContain("WORK");
  await auto.reload();
  await prompt(auto);
  await command(auto, "B:", "B>");
  expect(await command(auto, "DIR", "B>")).toContain("AUTO");
  expect(await triptychDatabases(page)).toEqual(["triptych-direct-b-v1"]);
});

test("an unknown direct disk fails without opening browser storage", async ({
  page,
}) => {
  await page.goto("/?disk=missing");
  await expect(page.locator("#status")).toContainText("unknown software name");
  expect(await triptychDatabases(page)).toEqual([]);
  await expect(page.locator("#open-library")).toBeHidden();
  await expect(page.locator("#files")).toBeHidden();
});
