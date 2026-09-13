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
  expect(await triptychDatabases(games)).toEqual([]);
  await expect(games.locator("#files")).toBeHidden();
  await expect(games.locator("#open-library")).toBeHidden();
});

test("the Advent link boots a stateless drive A containing the complete game", async ({
  page,
}) => {
  await page.goto("/?disk=advent");
  await prompt(page);
  await expect(page).toHaveTitle("Colossal Cave Adventure — Triptych");
  await expect(page.locator("#status")).toHaveText(
    "Colossal Cave is in drive A. Type ADVENT. B: is writable; cleared on page reload.",
  );
  await expect(page.locator("#open-library")).toBeHidden();
  await expect(page.locator("#files")).toBeHidden();
  expect(await triptychDatabases(page)).toEqual([]);

  const listing = await command(page, "DIR", "A>");
  expect(listing).toContain("ADVENT");
  expect(listing).toContain("PHROGZ");
  expect(listing).not.toContain("ADVENTUR");
  await command(page, "SAVE 1 DENIED.COM", "Bdos Err On A: Bad Sector");
  await page.locator("#reset").click();
  await prompt(page);
  await command(page, "ADVENT", "WOULD YOU LIKE INSTRUCTIONS?");
  expect(await triptychDatabases(page)).toEqual([]);

  await page.reload();
  await prompt(page);
  expect(await triptychDatabases(page)).toEqual([]);
  const afterReload = await command(page, "DIR", "A>");
  expect(afterReload).toContain("ADVENT");
  expect(afterReload).toContain("PHROGZ");
});

test("direct demos have an independent temporary writable B", async ({
  page,
  context,
}) => {
  await page.goto("/?disk=advent");
  await prompt(page);
  await command(page, "B:", "B>");
  await command(page, "SAVE 1 WORK.COM", "B>");
  expect(await command(page, "DIR", "B>")).toContain("WORK");
  await page.locator("#reset").click();
  await prompt(page);
  await command(page, "B:", "B>");
  expect(await command(page, "DIR", "B>")).toContain("WORK");
  const other = await context.newPage();
  await other.goto("/?disk=games");
  await prompt(other);
  await command(other, "B:", "B>");
  expect(await command(other, "DIR", "B>")).toContain("NO FILE");
  await page.reload();
  await prompt(page);
  await command(page, "B:", "B>");
  expect(await command(page, "DIR", "B>")).toContain("NO FILE");
  expect(await triptychDatabases(page)).toEqual([]);
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
