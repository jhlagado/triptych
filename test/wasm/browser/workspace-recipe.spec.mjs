import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const dist = new URL("../../../dist/wasm-browser/", import.meta.url);
const deployment = JSON.parse(
  await readFile(new URL("deployment-manifest.json", dist), "utf8"),
);
const asset = (prefix) =>
  deployment.assets.find((entry) => entry.path.startsWith(prefix)).path;
const atom = new Uint8Array(await readFile(new URL(asset("tool-atom-"), dist)));
const edit = new Uint8Array(await readFile(new URL(asset("tool-edit-"), dist)));
const example = new TextEncoder().encode(
  "; browser recipe example\n        ORG 100H\n        RET\n",
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const recipeUrl = "https://recipes.example/recipes/atom-starter.json";
const recipe = {
  schema: "triptych-file-recipe-v1",
  id: "atom-starter",
  revision: "browser-test",
  name: "Atom starter",
  instruction: "Type DIR, then assemble the example with ATOM.",
  profile: "triptych-cpu-v0.1-2m-n04",
  components: [
    {
      id: "atom",
      name: "ATOM.COM",
      description: "Assembler",
      files: [
        {
          name: "ATOM.COM",
          url: "https://recipes.example/assets/ATOM.COM",
          bytes: atom.length,
          sha256: hash(atom),
        },
      ],
    },
    {
      id: "edit",
      name: "EDIT.COM",
      description: "Editor",
      files: [
        {
          name: "EDIT.COM",
          url: "https://recipes.example/assets/EDIT.COM",
          bytes: edit.length,
          sha256: hash(edit),
        },
      ],
    },
    {
      id: "example",
      name: "EXAMPLE.ASM",
      description: "Source",
      files: [
        {
          name: "EXAMPLE.ASM",
          url: "https://recipes.example/assets/EXAMPLE.ASM",
          bytes: example.length,
          sha256: hash(example),
        },
      ],
    },
  ],
};
const files = new Map([
  ["/assets/ATOM.COM", atom],
  ["/assets/EDIT.COM", edit],
  ["/assets/EXAMPLE.ASM", example],
]);

async function prompt(page, suffix = "A>") {
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent())
        .trimEnd()
        .endsWith(suffix),
    )
    .toBe(true);
}

async function command(page, text, suffix = "A>") {
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

test("a static file recipe creates writable A and runs Atom from it", async ({
  page,
}) => {
  await page.route(
    "https://recipes.example/recipes/atom-starter.json",
    (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "application/json",
          "access-control-allow-origin": "*",
        },
        body: JSON.stringify(recipe),
      }),
  );
  await page.route("https://recipes.example/assets/*", async (route) => {
    const bytes = files.get(new URL(route.request().url()).pathname);
    if (!bytes) return route.abort();
    return route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "access-control-allow-origin": "*",
      },
      body: Buffer.from(bytes),
    });
  });
  await page.goto(`/?workspace=${encodeURIComponent(recipeUrl)}`);
  await prompt(page);
  await expect(page).toHaveTitle("Atom starter — Triptych");
  await expect(page.locator("#status")).toContainText(
    "Atom starter is in drive A",
  );
  const listing = await command(page, "DIR");
  for (const name of ["ATOM", "EDIT", "EXAMPLE"])
    expect(listing).toContain(name);
  await command(page, "ATOM EXAMPLE.ASM EXAMPLE.COM");
  expect(await command(page, "DIR")).toContain("EXAMPLE");
});
