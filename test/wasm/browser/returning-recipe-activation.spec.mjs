import { expect, test } from "@playwright/test";

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
const selected = (value) =>
  value.manifest.configurations.find(
    (row) => row.id === value.manifest.selectedConfigurationId,
  );
async function command(page, text) {
  const terminal = page.locator("#terminal"),
    before = await terminal.textContent();
  await terminal.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => {
      const after = await terminal.textContent();
      return after !== before && after.trimEnd().endsWith("A>");
    })
    .toBe(true);
}

test("a returning user explicitly activates the exact requested recipe, retains written disks, and reuses it without reseeding", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  const fresh = await state(page),
    original = selected(fresh);
  // Delay one real disk hash, not its bytes/result or any IndexedDB operation.
  // This makes the pending-save preview boundary deterministic without sleeps.
  await page.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    let held = false;
    crypto.subtle.digest = async (...args) => {
      const result = digest(...args);
      if (!held && args[1].byteLength === 2097152) {
        held = true;
        await new Promise((resolve) => {
          window.releasePreviewDiskHash = resolve;
        });
      }
      return result;
    };
  });
  await command(page, "SAVE 1 B:KEEP.COM");
  await command(page, "DIR B:*.*");
  await expect(page.locator("#terminal")).toContainText(/KEEP\s+COM/);
  await expect
    .poll(() => page.evaluate(() => typeof window.releasePreviewDiskHash))
    .toBe("function");
  const registry = await (
    await request.get("/disk-library-registry.json")
  ).json();
  const reference = registry.defaults.find(
    (row) => row.id === "colossal-cave-350",
  );
  expect(reference).toBeTruthy();
  const recipe = registry.recipes.find(
    (row) => row.id === reference.id && row.revision === reference.revision,
  );
  const url = `/?recipe=${reference.id}&revision=${reference.revision}`;
  await page.locator("#disk-library > summary").click();
  await expect(page.locator("#colossal-cave-guide")).toBeVisible();
  await page.locator("#colossal-cave-guide summary").click();
  await expect(page.locator("#colossal-cave-guide")).toContainText(
    "SAVE 224 B:SAVED.COM",
  );
  await expect(page.locator("#colossal-cave-guide")).toContainText(
    "four-drive (N4)",
  );
  await expect(page.locator("#share-colossal-cave")).toHaveAttribute(
    "href",
    url.slice(1),
  );
  await page.locator("#share-colossal-cave").click();
  await expect(page.locator("#requested-recipe-description")).toContainText(
    reference.revision,
  );
  expect(new URL(page.url()).search).toBe("");
  await expect(page.locator("#terminal")).toContainText(/KEEP\s+COM/);
  expect(await state(page)).toEqual(fresh);
  await page.evaluate(() => window.releasePreviewDiskHash());
  await expect(page.locator("#save-status")).toHaveAttribute(
    "data-state",
    "saved",
  );
  await expect
    .poll(
      async () =>
        (await state(page)).manifest.personalDisks.find(
          (row) => row.id === original.slots[1].diskId,
        ).content.sha256,
    )
    .not.toBe(
      fresh.manifest.personalDisks.find(
        (row) => row.id === original.slots[1].diskId,
      ).content.sha256,
    );
  const before = await state(page);
  await page.locator("#library-ready").check();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain(recipe.name);
    expect(dialog.message()).toContain("D: empty");
    expect(dialog.message()).toContain("retained");
    await dialog.dismiss();
  });
  await page.locator("#launch-requested").click();
  expect(await state(page)).toEqual(before);
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#launch-requested").click();
  await expect
    .poll(async () => selected(await state(page)).slots[2]?.image?.id)
    .toBe("colossal-cave-350");
  await expect(page.locator("#library-ready")).not.toBeChecked();
  const activated = await state(page);
  expect(selected(activated).id).not.toBe(original.id);
  expect(selected(activated).slots[3]).toBeNull();
  expect(
    activated.manifest.configurations.find((row) => row.id === original.id),
  ).toEqual(original);
  for (const disk of before.manifest.personalDisks)
    expect(
      activated.manifest.personalDisks.find((row) => row.id === disk.id),
    ).toEqual(disk);
  expect(activated.blobs).toEqual(expect.arrayContaining(before.blobs));
  expect(activated.blobs).not.toContain(
    selected(activated).slots[2].image.sha256,
  );
  await page.goto(url);
  await expect(page.locator("#terminal")).toContainText("A>");
  await page.locator("#library-ready").check();
  await page.locator("#launch-requested").click();
  await expect(page.locator("#library-ready")).not.toBeChecked();
  await expect(page.locator("#reset")).toBeEnabled();
  expect(await state(page)).toEqual(activated);
  await page.locator("#saved-configuration").selectOption(original.id);
  await page.locator("#library-ready").check();
  await page.locator("#activate-configuration").click();
  await expect
    .poll(async () => (await state(page)).manifest.selectedConfigurationId)
    .toBe(original.id);
  await expect(page.locator("#library-ready")).not.toBeChecked();
  await command(page, "DIR B:*.*");
  await expect(page.locator("#terminal")).toContainText(/KEEP\s+COM/);
});
