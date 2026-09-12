import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const IMAGE_ID = "colossal-cave-350";
const IMAGE_HASH =
  "5dc331b1be3609cb72bb728d3f64b811d9aea95b8357c9cb3224d150596bad33";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const selected = (value) =>
  value.manifest.configurations.find(
    (row) => row.id === value.manifest.selectedConfigurationId,
  );
const personal = (value, id) =>
  value.manifest.personalDisks.find((row) => row.id === id);

// Observe only the disposable Playwright context. All changes below go through
// the actual library UI or guest keyboard, never injected catalogue/DB state.
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
        const blobs = tx.objectStore("disk-box-blobs-v1").getAllKeys();
        tx.oncomplete = () =>
          resolve({ manifest: head.result.manifest, blobs: blobs.result });
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
}

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
async function openLibrary(page) {
  if (!(await page.locator("#disk-library").evaluate((node) => node.open)))
    await page.locator("#disk-library > summary").click();
}
async function mountPublished(page, request) {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/");
  await prompt(page);
  await openLibrary(page);
  const before = await state(page),
    config = selected(before);
  expect(config.configuredCount).toBe(4);
  expect(config.bootstrap.profile).toBe("triptych-cpu-v0.1-2m-n04");
  expect(config.slots.map((slot) => slot.kind)).toEqual([
    "published",
    "personal",
    "published",
    "personal",
  ]);
  const row = page.locator(
    `[data-published-image-id="${IMAGE_ID}"][data-published-image-revision="${IMAGE_HASH}"]`,
  );
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("protected");
  await page.locator("#library-slot").selectOption("2");
  await page.locator("#library-ready").check();
  await row.getByRole("button", { name: "Insert", exact: true }).click();
  await expect
    .poll(async () => selected(await state(page)).slots[2]?.image?.id)
    .toBe(IMAGE_ID);
  const mounted = await state(page),
    image = selected(mounted).slots[2].image;
  expect(image.revision).toBe(IMAGE_HASH);
  expect(image.sha256).toBe(IMAGE_HASH);
  expect(image.systemProfile).toBeNull();
  expect(mounted.manifest.personalDisks).toEqual(before.manifest.personalDisks);
  expect(mounted.blobs).not.toContain(IMAGE_HASH);
  for (const index of [0, 1, 3])
    expect(selected(mounted).slots[index]).toEqual(config.slots[index]);
  const response = await request.get(image.url);
  expect(response.ok()).toBe(true);
  const bytes = await response.body();
  expect(bytes.length).toBe(2097152);
  expect(hash(bytes)).toBe(IMAGE_HASH);
  expect(bytes.subarray(0, 16384).every((byte) => byte === 0)).toBe(true);
  return mounted;
}

async function playAndSuspend(page, destination) {
  await command(page, "C:", "C>");
  await command(page, "ADVENTUR", "WOULD YOU LIKE INSTRUCTIONS?");
  await command(page, "NO", "DOWN A GULLY.");
  await command(page, "ENTER", "THERE IS A BOTTLE OF WATER HERE.");
  await command(page, "TAKE KEYS", "OK");
  await command(page, "INVENTORY", "SET OF KEYS");
  await command(page, "SAVE", "IS THIS ACCEPTABLE?");
  await command(page, "YES", "C>");
  // 224 pages is the qualified N4 memory-image workflow, not a generic size.
  await command(page, `SAVE 224 ${destination}`, "C>");
}
async function checkpoint(page) {
  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#files-status")).toContainText("CPU paused.");
  await expect(page.locator("#cancel-management")).toBeEnabled();
  // Closing cancels only management, after its complete writable checkpoint.
  await page.locator("#close-files").click();
  await expect(page.locator("#reset")).toBeEnabled();
}
async function restoreAndQuit(page, executable) {
  await page.reload();
  await prompt(page);
  await command(page, "C:", "C>");
  await command(page, executable, "THERE IS A BOTTLE OF WATER HERE.");
  await command(page, "INVENTORY", "SET OF KEYS");
  await command(page, "QUIT", "DO YOU REALLY WANT TO QUIT NOW?");
  await command(page, "YES", "C>");
}
async function downloadC(page) {
  await page.locator("#files").click();
  await page.locator("#file-drive").selectOption("C");
  await page.locator("#close-files").click();
  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  return readFile(await (await pending).path());
}

test("the published Colossal Cave recipe link boots protected A/C and one private work disk", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const response = await request.get("/disk-library-registry.json");
  expect(response.ok()).toBe(true);
  const registry = await response.json(),
    reference = registry.defaults.find((row) => row.id === IMAGE_ID);
  expect(reference).toBeDefined();
  expect(reference.revision).toMatch(/^[a-f0-9]{64}$/);
  const route = new URLSearchParams({
    recipe: reference.id,
    revision: reference.revision,
  });
  await page.goto(`/?${route}`);
  await prompt(page);
  const initial = await state(page),
    config = selected(initial);
  expect(config.configuredCount).toBe(4);
  expect(config.bootstrap.profile).toBe("triptych-cpu-v0.1-2m-n04");
  expect(config.slots.map((slot) => slot?.kind ?? null)).toEqual([
    "published",
    "personal",
    "published",
    null,
  ]);
  expect(config.slots[1].writable).toBe(true);
  expect(initial.manifest.personalDisks).toHaveLength(1);
  expect(initial.manifest.personalDisks[0].id).toBe(config.slots[1].diskId);
  expect(config.slots[2].image.id).toBe(IMAGE_ID);
  expect(config.slots[2].image.revision).toBe(IMAGE_HASH);
  expect(config.slots[2].image.sha256).toBe(IMAGE_HASH);
  for (const index of [0, 2])
    expect(initial.blobs).not.toContain(config.slots[index].image.sha256);
  await command(page, "C:", "C>");
  await command(page, "ADVENTUR", "WOULD YOU LIKE INSTRUCTIONS?");
  await command(page, "NO", "DOWN A GULLY.");
  await command(page, "ENTER", "THERE IS A BOTTLE OF WATER HERE.");
  await command(page, "TAKE KEYS", "OK");
  await command(page, "INVENTORY", "SET OF KEYS");
  await command(page, "QUIT", "DO YOU REALLY WANT TO QUIT NOW?");
  await command(page, "YES", "C>");
  expect(await state(page)).toEqual(initial);
});

test("published Colossal Cave saves on B and restores keys after reload without copying protected C", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const initial = await mountPublished(page, request),
    config = selected(initial);
  await playAndSuspend(page, "B:SAVED.COM");
  await checkpoint(page);
  const saved = await state(page);
  expect(personal(saved, config.slots[1].diskId).content.sha256).not.toBe(
    personal(initial, config.slots[1].diskId).content.sha256,
  );
  expect(personal(saved, config.slots[3].diskId)).toEqual(
    personal(initial, config.slots[3].diskId),
  );
  expect(selected(saved)).toEqual(config);
  expect(saved.blobs).not.toContain(IMAGE_HASH);
  await restoreAndQuit(page, "B:SAVED");
  expect((await state(page)).manifest).toEqual(saved.manifest);
  expect(hash(await downloadC(page))).toBe(IMAGE_HASH);
  await command(page, "SAVE 1 DENIED.COM", "Bdos Err On C: Bad Sector");
  expect((await state(page)).manifest).toEqual(saved.manifest);
  expect((await state(page)).blobs).not.toContain(IMAGE_HASH);
  expect(hash(await downloadC(page))).toBe(IMAGE_HASH);
});

test("an explicit personal Colossal Cave copy saves on C independently of its published source and B/D", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const initial = await mountPublished(page, request),
    original = selected(initial);
  await page.locator("#library-name").fill("My Colossal Cave");
  await page.locator("#library-ready").check();
  await page.locator("#library-copy").click();
  await expect
    .poll(async () => (await state(page)).manifest.personalDisks.length)
    .toBe(initial.manifest.personalDisks.length + 1);
  const copied = await state(page),
    disk = copied.manifest.personalDisks.find(
      (row) => row.name === "My Colossal Cave",
    );
  expect(disk.content.sha256).toBe(IMAGE_HASH);
  expect([original.slots[1].diskId, original.slots[3].diskId]).not.toContain(
    disk.id,
  );
  await page.locator("#library-ready").check();
  await page
    .locator(`[data-disk-id="${disk.id}"]`)
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await expect
    .poll(async () => selected(await state(page)).slots[2]?.diskId)
    .toBe(disk.id);
  expect(selected(await state(page)).slots[2].writable).toBe(true);
  await playAndSuspend(page, "SAVED.COM");
  await checkpoint(page);
  const saved = await state(page);
  expect(personal(saved, disk.id).content.sha256).not.toBe(IMAGE_HASH);
  for (const index of [1, 3])
    expect(personal(saved, original.slots[index].diskId)).toEqual(
      personal(initial, original.slots[index].diskId),
    );
  expect(selected(saved).slots[0]).toEqual(original.slots[0]);
  await restoreAndQuit(page, "SAVED");
  expect((await state(page)).manifest).toEqual(saved.manifest);
  expect(hash(await downloadC(page))).toBe(
    personal(saved, disk.id).content.sha256,
  );
  const source = await request.get(original.slots[2].image.url);
  expect(source.ok()).toBe(true);
  expect(hash(await source.body())).toBe(IMAGE_HASH);
});
