// Deliberately use the real public configuration, not the legacy fixture.
import { expect, test } from "@playwright/test";

async function prompt(page, suffix) {
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent())
        .trimEnd()
        .endsWith(suffix),
    )
    .toBe(true);
}
async function send(page, text) {
  await page.locator("#terminal").focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}
async function state(page, name = "triptych-cpu") {
  return page.evaluate(async (name) => {
    const { openDriveSetStore } = await import("./drive-set-store.js");
    const { CpmDisk } = await import("./triptych_host_wasm.js");
    const store = await openDriveSetStore({ name });
    try {
      const head = await store.load();
      if (head.kind !== "ready") return { kind: head.kind };
      const drives = {};
      for (const [letter, image] of Object.entries(head.snapshot.drives)) {
        if (!image) {
          drives[letter] = null;
          continue;
        }
        const disk = new CpmDisk(image.bytes);
        try {
          drives[letter] = {
            files: disk.file_names().sort(),
            bytes: image.bytes.length,
            digest: Array.from(
              new Uint8Array(
                await crypto.subtle.digest("SHA-256", image.bytes),
              ),
            ).join(","),
          };
        } finally {
          disk.free();
        }
      }
      return {
        kind: head.kind,
        profile: head.snapshot.bootstrap.profile,
        drives,
      };
    } finally {
      store.close();
    }
  }, name);
}

test("real public default boots A tools and B games; both games save and reload on B", async ({
  page,
}) => {
  await page.goto("/");
  await prompt(page, "A>");
  const initial = await state(page);
  expect(initial.profile).toBe("triptych-cpu-v0.1-8m-ab");
  expect(initial.drives.A.bytes).toBe(8388608);
  expect(initial.drives.B.bytes).toBe(8388608);
  expect(initial.drives.A.files).toEqual(
    expect.arrayContaining(["ATOM.COM", "NUC.COM", "EDIT.COM", "INPUT.NU"]),
  );
  expect(initial.drives.A.files).not.toContain("CAVERNS.COM");
  expect(initial.drives.A.files).not.toContain("HYPERDRV.COM");
  expect(initial.drives.B.files).toEqual([
    "CAVERNS.COM",
    "HYPERDRV.COM",
    "README.TXT",
  ]);
  await send(page, "B:");
  await prompt(page, "B>");
  for (const game of ["CAVERNS", "HYPERDRV"]) {
    await send(page, game);
    if (game === "CAVERNS") {
      await prompt(page, "[Space/Enter: more, Q: skip]");
      await page.keyboard.type("q");
    }
    await prompt(page, "?");
    await send(page, "SAVE");
    await expect(page.locator("#terminal")).toContainText("Game saved");
    await prompt(page, "?");
    await send(page, "QUIT");
    await prompt(
      page,
      game === "CAVERNS" ? "Another adventure?" : "Return to CP/M? (Y/N)",
    );
    await send(page, game === "CAVERNS" ? "N" : "Y");
    await prompt(page, "B>");
  }
  await expect
    .poll(async () => (await state(page)).drives.B.files)
    .toEqual(expect.arrayContaining(["CAVERNS.SAV", "HYPERDRV.SAV"]));
  const saved = await state(page);
  expect(saved.drives.A).toEqual(initial.drives.A);
  // A returning machine does not fetch/reseed newer defaults.
  await page.route("**/config.json", (route) => route.abort());
  await page.route("**/drive-*-*.img", (route) => route.abort());
  await page.reload();
  await prompt(page, "A>");
  expect(await state(page)).toEqual(saved);
  await send(page, "B:");
  await prompt(page, "B>");
  for (const game of ["CAVERNS", "HYPERDRV"]) {
    await send(page, game);
    if (game === "CAVERNS") {
      await prompt(page, "[Space/Enter: more, Q: skip]");
      await page.keyboard.type("q");
    }
    await prompt(page, "?");
    await send(page, "LOAD");
    await expect(page.locator("#terminal")).toContainText("Game loaded");
    await prompt(page, "?");
    await send(page, "QUIT");
    await prompt(
      page,
      game === "CAVERNS" ? "Another adventure?" : "Return to CP/M? (Y/N)",
    );
    await send(page, game === "CAVERNS" ? "N" : "Y");
    await prompt(page, "B>");
  }
});

test("supplied machine link preserves the usual machine and keeps independent saves", async ({
  page,
}) => {
  await page.goto("/");
  await prompt(page, "A>");
  await send(page, "ATOM HELLO.ASM");
  await prompt(page, "A>");
  await expect
    .poll(async () => (await state(page)).drives.A.files)
    .toContain("HELLO.COM");
  const usual = await state(page);
  await page.locator("#supplied-disks summary").click();
  await page
    .getByRole("link", { name: "Open the supplied A+B machine" })
    .click();
  await prompt(page, "A>");
  expect(await state(page)).toEqual(usual);
  const separate = await state(page, "triptych-supplied");
  expect(separate.drives.A.files).not.toContain("HELLO.COM");
  expect(separate.drives.B.files).toContain("CAVERNS.COM");
  await send(page, "ERA B:README.TXT");
  await prompt(page, "A>");
  await expect
    .poll(async () => (await state(page, "triptych-supplied")).drives.B.files)
    .not.toContain("README.TXT");
  const changed = await state(page, "triptych-supplied");
  expect(changed.drives.A).toEqual(separate.drives.A);
  expect(await state(page)).toEqual(usual);
  await page.reload();
  await prompt(page, "A>");
  expect(await state(page, "triptych-supplied")).toEqual(changed);
  await page.goto("/");
  await prompt(page, "A>");
  expect(await state(page)).toEqual(usual);
});

test("missing B image never publishes a partial starter machine", async ({
  page,
}) => {
  await page.route("**/drive-b-games.img", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  expect(await state(page)).toEqual({ kind: "empty" });
});
