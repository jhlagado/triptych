// Deliberately use the real public configuration, not the legacy fixture.
import { expect, test } from "@playwright/test";
import {
  seedLegacyDisk,
  adoptHistoricalMachine,
  inspectDiskBox,
} from "./legacy-fixture.mjs";

async function historicalAB(page) {
  await page.route("**/public-ab-seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/public-ab-seed");
  await page.evaluate(async () => {
    const { openSavedMachineStore } = await import("/saved-machine-store.js");
    const read = async (name) =>
      new Uint8Array(await (await fetch(`/${name}`)).arrayBuffer());
    const store = await openSavedMachineStore();
    try {
      await store.saveCheckpoint(
        { kind: "empty" },
        {
          bootstrap: {
            profile: "triptych-cpu-v0.1-8m-ab",
            bytes: await read("bootstrap-triptych-cpm-8m-ab-v1.bin"),
          },
          drives: {
            A: {
              name: "drive-a-system.img",
              bytes: await read("drive-a-system.img"),
            },
            B: {
              name: "drive-b-games.img",
              bytes: await read("drive-b-games.img"),
            },
          },
        },
      );
    } finally {
      store.close();
    }
  });
  await adoptHistoricalMachine(page);
}

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
    const { openDiskBoxAppStore } = await import("./disk-box-app-store.js");
    const { CpmDisk } = await import("./triptych_host_wasm.js");
    const store = await openDiskBoxAppStore({
      name,
      lease: { isOwner: () => false },
    });
    try {
      const head = await store.load();
      if (head.kind !== "ready")
        return {
          kind: head.kind,
          ...(head.error ? { error: head.error } : {}),
        };
      if (head.token.kind !== "disk-box")
        throw new Error(
          "Public startup must use the current saved-machine authority",
        );
      const drives = {};
      const slots = head.snapshot.slots
        ? Object.fromEntries(
            head.snapshot.slots.map((slot, i) => [
              String.fromCharCode(65 + i),
              slot,
            ]),
          )
        : head.snapshot.drives;
      for (const [letter, image] of Object.entries(slots)) {
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

test("historical published A/B images adopt exactly; both games save and reload on writable B", async ({
  page,
}) => {
  await historicalAB(page);
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
  expect(initial.drives.A.files).not.toContain("HYPERD2.COM");
  expect(initial.drives.B.files).toEqual([
    "CAVERNS.COM",
    "HYPERD2.COM",
    "HYPERDRV.COM",
    "README.TXT",
  ]);
  await send(page, "B:");
  await prompt(page, "B>");
  for (const game of ["CAVERNS", "HYPERDRV", "HYPERD2"]) {
    await send(page, game);
    if (["CAVERNS", "HYPERD2"].includes(game)) {
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
      game === "CAVERNS"
        ? "Another adventure?"
        : game === "HYPERDRV"
          ? "Return to CP/M? (Y/N)"
          : "any other key=cancel:",
    );
    await send(page, game === "CAVERNS" ? "N" : "Y");
    await prompt(page, "B>");
  }
  await expect
    .poll(async () => (await state(page)).drives.B.files)
    .toEqual(
      expect.arrayContaining(["CAVERNS.SAV", "HYPERDRV.SAV", "HYPERD2.SAV"]),
    );
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
  for (const game of ["CAVERNS", "HYPERDRV", "HYPERD2"]) {
    await send(page, game);
    if (["CAVERNS", "HYPERD2"].includes(game)) {
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
      game === "CAVERNS"
        ? "Another adventure?"
        : game === "HYPERDRV"
          ? "Return to CP/M? (Y/N)"
          : "any other key=cancel:",
    );
    await send(page, game === "CAVERNS" ? "N" : "Y");
    await prompt(page, "B>");
  }
});

test("supplied machine link preserves the usual machine and keeps independent saves", async ({
  page,
}) => {
  await seedLegacyDisk(page);
  await adoptHistoricalMachine(page);
  await prompt(page, "A>");
  await send(page, "ATOM HELLO.ASM");
  await prompt(page, "A>");
  await expect
    .poll(async () => {
      const loaded = await state(page);
      return {
        kind: loaded.kind,
        error: loaded.error,
        files: loaded.drives?.A?.files,
      };
    })
    .toMatchObject({
      kind: "ready",
      files: expect.arrayContaining(["HELLO.COM"]),
    });
  const usual = await state(page);
  await page.locator("#open-library").click();
  await page.locator("#supplied-disks summary").click();
  await page
    .getByRole("link", { name: "Open the older supplied machine" })
    .click();
  await prompt(page, "A>");
  expect(await state(page)).toEqual(usual);
  const separate = await state(page, "triptych-supplied");
  expect(separate.drives.A.files).not.toContain("HELLO.COM");
  expect(separate.drives.C.files).toContain("CAVERNS.COM");
  await send(page, "D:");
  await prompt(page, "D>");
  await send(page, "SAVE 1 LINK.COM");
  await prompt(page, "D>");
  await expect
    .poll(async () => {
      const loaded = await state(page, "triptych-supplied");
      return {
        kind: loaded.kind,
        error: loaded.error,
        files: loaded.drives?.D?.files,
      };
    })
    .toMatchObject({
      kind: "ready",
      files: expect.arrayContaining(["LINK.COM"]),
    });
  const changed = await state(page, "triptych-supplied");
  expect(changed.drives.A).toEqual(separate.drives.A);
  expect(changed.drives.C).toEqual(separate.drives.C);
  expect(await state(page)).toEqual(usual);
  await page.reload();
  await prompt(page, "A>");
  expect(await state(page, "triptych-supplied")).toEqual(changed);
  await page.goto("/");
  await prompt(page, "A>");
  expect(await state(page)).toEqual(usual);
});

test("missing protected games image never publishes a partial starter disk box", async ({
  page,
}) => {
  await page.route("**/library-games-2m-*.img", (route) => route.abort());
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  expect(await state(page)).toEqual({ kind: "unadopted" });
  const raw = await page.evaluate(async () => {
    const { openDiskBoxStore } = await import("/disk-box-store.js");
    const store = await openDiskBoxStore({ lease: { isOwner: () => false } });
    try {
      return {
        head: await store.readRawRecovery("disk-box-state-v1", "head"),
        blobs: await store.readRawRecords("disk-box-blobs-v1"),
      };
    } finally {
      store.close();
    }
  });
  expect(raw).toEqual({ head: undefined, blobs: [] });
});

test("fresh public default uses protected A/C and private B/D without published database copies", async ({
  page,
}) => {
  await page.goto("/");
  await prompt(page, "A>");
  const loaded = await inspectDiskBox(page);
  const config = loaded.manifest.configurations.find(
    (c) => c.id === loaded.manifest.selectedConfigurationId,
  );
  expect(config.configuredCount).toBe(4);
  expect(config.slots.map((slot) => slot.kind)).toEqual([
    "published",
    "personal",
    "published",
    "personal",
  ]);
  expect(
    config.slots
      .filter((slot) => slot.kind === "personal")
      .every((slot) => slot.writable),
  ).toBe(true);
  const initial = await state(page);
  expect(initial.profile).toBe("triptych-cpu-v0.1-2m-n04");
  expect(initial.drives.A.files).toEqual(
    expect.arrayContaining(["ATOM.COM", "EDIT.COM", "NUC.COM"]),
  );
  expect(initial.drives.C.files).toEqual([
    "CAVERNS.COM",
    "HYPERD2.COM",
    "HYPERDRV.COM",
    "README.TXT",
  ]);
  expect(initial.drives.B.files).toEqual([]);
  expect(initial.drives.D.files).toEqual([]);
  const hashes = await page.evaluate(async () => {
    const { openDiskBoxStore } = await import("/disk-box-store.js");
    const store = await openDiskBoxStore({ lease: { isOwner: () => false } });
    try {
      return (await store.readRawRecords("disk-box-blobs-v1")).map(
        (row) => row.sha256,
      );
    } finally {
      store.close();
    }
  });
  for (const slot of config.slots.filter((slot) => slot.kind === "published"))
    expect(hashes).not.toContain(slot.image.sha256);
});
