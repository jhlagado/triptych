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

for (const rejectedAsset of ["bootstrap", "seed"]) {
  test(`failed fresh ${rejectedAsset} preparation resumes the original machine and permits retry`, async ({
    page,
    request,
  }) => {
    await page.goto("/");
    const terminal = page.locator("#terminal");
    await expect(terminal).toContainText("A>");
    await page.locator("#disk-library > summary").click();
    await expect(page.locator("#share-starter")).toHaveAttribute(
      "href",
      /revision=[a-f0-9]{64}$/,
    );
    const before = await state(page);
    const registry = await (
      await request.get("/disk-library-registry.json")
    ).json();
    const selected = registry.defaults.find((row) => row.id === "starter");
    const recipe = registry.recipes.find(
      (row) => row.id === selected.id && row.revision === selected.revision,
    );
    const asset =
      rejectedAsset === "bootstrap"
        ? recipe.bootstrap
        : recipe.slots.find((slot) => slot?.kind === "writable-role").seed
            .asset;
    let rejected = 0;
    const route = async (route) => {
      rejected++;
      await route.abort("failed");
    };
    await page.route(`**/${asset}`, route);
    page.on("dialog", (dialog) => dialog.accept());
    await page.locator("#library-ready").check();
    await page.locator("#launch-fresh").click();
    await expect.poll(() => rejected).toBe(1);
    await expect(page.locator("#library-status")).not.toHaveText(
      /^Personal disks:/,
    );
    await expect(page.locator("#reset")).toBeEnabled();
    expect(await state(page)).toEqual(before);

    const originalScreen = await terminal.textContent();
    await terminal.focus();
    await page.keyboard.type("DIR");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => {
        const screen = await terminal.textContent();
        return (
          screen !== originalScreen &&
          screen.includes("DIR") &&
          screen.trimEnd().endsWith("A>")
        );
      })
      .toBe(true);
    expect(await state(page)).toEqual(before);

    await page.unroute(`**/${asset}`, route);
    await page.locator("#library-ready").check();
    await page.locator("#launch-fresh").click();
    await expect
      .poll(async () => (await state(page)).manifest.configurations.length)
      .toBe(before.manifest.configurations.length + 1);
    const after = await state(page);
    for (const disk of before.manifest.personalDisks)
      expect(
        after.manifest.personalDisks.find((item) => item.id === disk.id),
      ).toEqual(disk);
    expect(after.manifest.personalDisks.length).toBe(
      before.manifest.personalDisks.length + 2,
    );
    await expect(page.locator("#reset")).toBeEnabled();
  });
}
