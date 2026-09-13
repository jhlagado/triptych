import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { decodeDiskBoxRecovery } from "../../../crates/triptych-host-wasm/web/disk-box-recovery.js";
import { seedHistoricalRecords } from "./legacy-fixture.mjs";
import { openDownloads } from "./downloads-fixture.mjs";

test("raw backup preserves malformed historical records without adopting them", async ({
  page,
}) => {
  const record = {
    key: "drive-a",
    schema: "unrecognized-historical-record",
    name: "Original damaged disk",
    bytes: Uint8Array.of(0, 255, 17, 42),
    diagnostic: { note: "retain exactly", invalidHash: "not-a-hash" },
  };
  await seedHistoricalRecords(page, {
    version: 1,
    stores: [
      { name: "working-disks", keyPath: "key", records: [{ value: record }] },
    ],
  });
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  await page.locator("#open-library").click();
  await openDownloads(page);
  const pending = page.waitForEvent("download");
  await page.locator("#library-backup").click();
  const bytes = await readFile(await (await pending).path());
  const recovered = await decodeDiskBoxRecovery(new Blob([bytes]));
  expect(recovered["working-disks"]).toEqual([record]);
  expect(recovered["disk-box-state-v1"]).toEqual([]);
  expect(recovered["disk-box-blobs-v1"]).toEqual([]);
});

test("published disk-box client declares its actual storage contract", async ({
  request,
}) => {
  const manifest = await (
    await request.get("/deployment-manifest.json")
  ).json();
  expect(manifest.storageSchema).toBe("triptych-disk-box-v1");
});

// This suite intentionally uses the deployed app and real public catalogue,
// not the historical configuration fixture used by archive-workspace tests.
async function boot(page, route = "/") {
  await page.goto(route);
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent()).trimEnd().endsWith("A>"),
    )
    .toBe(true);
  await page.locator("#open-library").click();
  await expect(page.locator("#share-starter")).toHaveAttribute(
    "href",
    /revision=[a-f0-9]{64}$/,
  );
}
async function state(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-cpu");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(["disk-box-state-v1", "disk-box-blobs-v1"]);
        const head = tx.objectStore("disk-box-state-v1").get("head");
        const keys = tx.objectStore("disk-box-blobs-v1").getAllKeys();
        tx.oncomplete = () =>
          resolve({
            manifest: head.result?.manifest,
            blobs: keys.result,
            version: db.version,
          });
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}
const selected = (value) =>
  value.manifest.configurations.find(
    (item) => item.id === value.manifest.selectedConfigurationId,
  );

for (const recovery of ["reset", "reload"]) {
  test(`ejected A requires explicit original-system restoration after ${recovery}`, async ({
    page,
  }) => {
    await boot(page);
    const before = await state(page);
    const original = selected(before);
    await page.locator("#library-slot").selectOption("0");
    await page.locator("#library-ready").check();
    await page.locator("#library-eject").click();
    await expect
      .poll(async () => selected(await state(page)).slots[0])
      .toBeNull();
    expect(selected(await state(page)).systemDisk).toEqual(original.systemDisk);
    if (recovery === "reset") {
      await page.locator("#close-library").click();
      await expect(page.locator("#reset")).toBeEnabled();
      await page.locator("#reset").click();
    } else await page.reload();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "recovery",
    );
    await expect(page.locator("#restore-system-disk")).toBeVisible();
    expect(selected(await state(page)).slots[0]).toBeNull();
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#library-ready").check();
    await page.locator("#restore-system-disk").click();
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "running",
    );
    await expect
      .poll(async () =>
        (await page.locator("#terminal").textContent())
          .trimEnd()
          .endsWith("A>"),
      )
      .toBe(true);
    const after = await state(page);
    expect(selected(after).slots).toEqual(original.slots);
    expect(after.manifest.personalDisks).toEqual(before.manifest.personalDisks);
    expect(after.blobs).toEqual(before.blobs);
  });
}

test("complete backup downloads recoverable ejected disks without copying protected images", async ({
  page,
}) => {
  await boot(page);
  await page.locator("#library-name").fill("Keep while ejected");
  await page.locator("#library-ready").check();
  await page.locator("#library-blank").click();
  await expect(page.locator("#personal-disk-list li")).toHaveCount(3);
  const before = await state(page);
  await openDownloads(page);
  const downloaded = page.waitForEvent("download");
  await page.locator("#library-backup").click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("triptych-disk-box-recovery.tdbr");
  const bytes = await readFile(await download.path());
  const recovered = await decodeDiskBoxRecovery(new Blob([bytes]));
  expect(Object.keys(recovered)).toHaveLength(8);
  const head = recovered["disk-box-state-v1"].find((row) => row.key === "head");
  expect(head.manifest).toEqual(before.manifest);
  const blobs = recovered["disk-box-blobs-v1"];
  expect(blobs.map((row) => row.sha256).sort()).toEqual(
    [...before.blobs].sort(),
  );
  for (const disk of head.manifest.personalDisks) {
    const content = blobs.find((row) => row.sha256 === disk.content.sha256);
    expect(content.bytes.byteLength).toBe(disk.content.byteLength);
    expect(createHash("sha256").update(content.bytes).digest("hex")).toBe(
      disk.content.sha256,
    );
  }
  for (const slot of selected(before).slots.filter(
    (slot) => slot?.kind === "published",
  ))
    expect(blobs.some((row) => row.sha256 === slot.image.sha256)).toBe(false);
  expect(await state(page)).toEqual(before);
});

async function command(page, text, suffix = "?") {
  const terminal = page.locator("#terminal"),
    before = await terminal.textContent();
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
async function launchGame(page, game) {
  await command(
    page,
    "C:" + game,
    game === "CAVERNS" ? "[Space/Enter: more, Q: skip]" : "?",
  );
  if (game === "CAVERNS") {
    await page.keyboard.type("q");
    await expect
      .poll(async () =>
        (await page.locator("#terminal").textContent()).trimEnd().endsWith("?"),
      )
      .toBe(true);
  }
}
async function inventory(page) {
  const text = await command(page, "INVENTORY");
  return text.slice(text.lastIndexOf("INVENTORY")).replace(/\r/g, "").trim();
}
async function quitGame(page, game) {
  await command(
    page,
    "QUIT",
    game === "CAVERNS" ? "Another adventure?" : "Return to CP/M? (Y/N)",
  );
  await command(page, game === "CAVERNS" ? "N" : "Y", "D>");
}

test("real games restore changed inventory from private D across browser reload while A/C remain protected", async ({
  page,
}) => {
  await boot(page);
  const original = await state(page),
    originalConfig = selected(original);
  await page.locator("#close-library").click();
  await command(page, "D:", "D>");
  const savedInventory = {};
  for (const game of ["CAVERNS", "HYPERDRV"]) {
    await launchGame(page, game);
    expect(await inventory(page)).not.toMatch(/compass/i);
    await command(page, "TAKE COMPASS");
    savedInventory[game] = await inventory(page);
    expect(savedInventory[game]).toMatch(/compass/i);
    await command(page, "SAVE");
    await command(page, "DROP COMPASS");
    expect(await inventory(page)).not.toMatch(/compass/i);
    await command(page, "LOAD");
    expect(await inventory(page)).toBe(savedInventory[game]);
    await quitGame(page, game);
  }
  const files = () =>
    page.evaluate(async () => {
      const { openDiskBoxStore } = await import("./disk-box-store.js");
      const { CpmDisk } = await import("./triptych_host_wasm.js");
      const store = await openDiskBoxStore({ name: "triptych-cpu" });
      try {
        const loaded = await store.load(),
          config = loaded.manifest.configurations.find(
            (item) => item.id === loaded.manifest.selectedConfigurationId,
          );
        const disk = new CpmDisk(
          await store.readPersonalDisk(config.slots[3].diskId),
        );
        try {
          return disk.file_names().sort();
        } finally {
          disk.free();
        }
      } finally {
        store.close();
      }
    });
  await expect.poll(files).toEqual(["CAVERNS.SAV", "HYPERDRV.SAV"]);
  const saved = await state(page),
    config = selected(saved);
  for (const index of [0, 2]) {
    expect(config.slots[index]).toEqual(originalConfig.slots[index]);
    expect(saved.blobs).not.toContain(config.slots[index].image.sha256);
  }
  const work = originalConfig.slots[1].diskId;
  expect(saved.manifest.personalDisks.find((disk) => disk.id === work)).toEqual(
    original.manifest.personalDisks.find((disk) => disk.id === work),
  );
  await page.reload();
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent()).trimEnd().endsWith("A>"),
    )
    .toBe(true);
  await command(page, "D:", "D>");
  for (const game of ["CAVERNS", "HYPERDRV"]) {
    await launchGame(page, game);
    expect(await inventory(page)).not.toMatch(/compass/i);
    await command(page, "LOAD");
    expect(await inventory(page)).toBe(savedInventory[game]);
    await quitGame(page, game);
  }
  expect((await state(page)).manifest).toEqual(saved.manifest);
});

test("fresh public app keeps A/C protected, B/D private and revisits the same immutable recipe instance", async ({
  page,
}) => {
  await boot(page);
  const initial = await state(page),
    config = selected(initial);
  expect(initial.version).toBe(5);
  expect(config.configuredCount).toBe(4);
  expect(config.slots.map((slot) => slot.kind)).toEqual([
    "published",
    "personal",
    "published",
    "personal",
  ]);
  expect(config.slots[1].writable).toBe(true);
  expect(config.slots[3].writable).toBe(true);
  expect(config.slots[1].diskId).not.toBe(config.slots[3].diskId);
  expect(initial.manifest.personalDisks).toHaveLength(2);
  for (const index of [0, 2])
    expect(initial.blobs).not.toContain(config.slots[index].image.sha256);
  const link = await page.locator("#share-starter").getAttribute("href");
  expect(link).not.toContain(config.slots[1].diskId);
  expect(link).not.toContain(config.id);
  await page.goto(link);
  await expect(page.locator("#terminal")).toContainText("A>");
  const revisited = await state(page);
  expect(revisited.manifest).toEqual(initial.manifest);
  expect(revisited.blobs).toEqual(initial.blobs);
});

test("blank disks remain independent of drive slots and a writable copy does not mutate its published source", async ({
  page,
}) => {
  await boot(page);
  const initial = await state(page),
    original = selected(initial);
  await page.locator("#library-name").fill("Independent disk");
  await page.locator("#library-ready").check();
  await page.locator("#library-blank").click();
  await expect(page.locator("#personal-disk-list li")).toHaveCount(3);
  const created = await state(page),
    disk = created.manifest.personalDisks.find(
      (item) => item.name === "Independent disk",
    );
  expect(disk).toBeTruthy();
  expect(selected(created).slots).toEqual(original.slots);
  const row = page.locator(`[data-disk-id="${disk.id}"]`);
  await expect(row).toContainText("not inserted");
  await page.locator("#library-slot").selectOption("1");
  await page.locator("#library-ready").check();
  await row.getByRole("button", { name: /^Insert / }).click();
  await expect
    .poll(async () => selected(await state(page)).slots[1]?.diskId)
    .toBe(disk.id);
  await page.locator("#library-ready").check();
  await page.locator("#library-eject").click();
  await expect
    .poll(async () => selected(await state(page)).slots[1])
    .toBeNull();
  await expect(row).toContainText("not inserted");
  await page.locator("#library-ready").check();
  await row.getByRole("button", { name: /^Insert / }).click();
  await expect
    .poll(async () => selected(await state(page)).slots[1]?.diskId)
    .toBe(disk.id);
  await page.locator("#library-slot").selectOption("2");
  await page.locator("#library-name").fill("My games copy");
  await page.locator("#library-ready").check();
  await page.locator("#library-copy").click();
  await expect(page.locator("#personal-disk-list li")).toHaveCount(4);
  const copied = await state(page),
    copy = copied.manifest.personalDisks.find(
      (item) => item.name === "My games copy",
    );
  expect(copy.content.sha256).toBe(original.slots[2].image.sha256);
  expect(selected(copied).slots[2]).toEqual(original.slots[2]);
  expect(selected(copied).systemDisk).toEqual(original.systemDisk);
  await page.reload();
  await expect(page.locator("#terminal")).toContainText("A>");
  const restored = await state(page);
  expect(selected(restored).slots[1].diskId).toBe(disk.id);
  expect(restored.manifest.personalDisks).toHaveLength(4);
});

test("an unknown recipe revision fails without replacing an existing disk box", async ({
  page,
}) => {
  await boot(page);
  const before = await state(page);
  await page.goto("/?recipe=starter&revision=unavailable-old-release");
  await expect(page.locator("#status")).toHaveAttribute("data-state", "error");
  expect(await state(page)).toEqual(before);
});

test("protected-only shared recipe boots a new browser with no personal disk records or blobs", async ({
  page,
  browser,
}, testInfo) => {
  await boot(page);
  await expect(page.locator("#share-library")).toHaveAttribute(
    "href",
    /recipe=library&revision=[a-f0-9]{64}$/,
  );
  const url = new URL(
    await page.locator("#share-library").getAttribute("href"),
    page.url(),
  ).href;
  const context = await browser.newContext();
  try {
    const recipient = await context.newPage();
    await recipient.goto(url);
    await expect
      .poll(async () =>
        (await recipient.locator("#terminal").textContent())
          .trimEnd()
          .endsWith("A>"),
      )
      .toBe(true);
    const box = await state(recipient),
      config = selected(box);
    expect(config.configuredCount).toBe(4);
    expect(config.slots.map((slot) => slot?.kind ?? null)).toEqual([
      "published",
      null,
      "published",
      null,
    ]);
    expect(box.manifest.personalDisks).toEqual([]);
    expect(box.blobs).toEqual([]);
    await recipient.reload();
    await expect
      .poll(async () =>
        (await recipient.locator("#terminal").textContent())
          .trimEnd()
          .endsWith("A>"),
      )
      .toBe(true);
    expect((await state(recipient)).manifest).toEqual(box.manifest);
    expect((await state(recipient)).blobs).toEqual([]);
    await recipient.setViewportSize({ width: 1280, height: 1000 });
    await recipient.screenshot({
      path: testInfo.outputPath("disk-library-desktop.png"),
      fullPage: true,
    });
    await recipient.setViewportSize({ width: 390, height: 844 });
    await recipient.screenshot({
      path: testInfo.outputPath("disk-library-mobile.png"),
      fullPage: true,
    });
    for (const name of ["desktop", "mobile"])
      await testInfo.attach(`Disk library ${name}`, {
        path: testInfo.outputPath(`disk-library-${name}.png`),
        contentType: "image/png",
      });
  } finally {
    await context.close();
  }
  const before = await state(page);
  page.on("dialog", (dialog) => dialog.accept());
  await page
    .locator("#ready-made-machines")
    .evaluate((node) => (node.open = true));
  await page.locator("#library-ready").check();
  await page.locator("#launch-library").click();
  await expect
    .poll(async () => selected(await state(page)).slots[1])
    .toBeNull();
  const after = await state(page);
  expect(after.manifest.personalDisks).toEqual(before.manifest.personalDisks);
  expect(after.blobs).toEqual(before.blobs);
});
