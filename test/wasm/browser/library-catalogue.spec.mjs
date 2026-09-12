import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

test("a retained image outside all recipes is visible and mounts protected without a personal copy", async ({
  page,
  request,
}) => {
  const registry = await (
    await request.get("/disk-library-registry.json")
  ).json();
  const source = registry.images.find((image) => image.systemProfile === null);
  const bytes = Buffer.from(
    await (await request.get(`/${source.asset}`)).body(),
  );
  // Change an unused final data byte, retaining a valid directory/geometry.
  bytes[bytes.length - 1] ^= 1;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const image = {
    ...source,
    id: "extra-data-proof",
    name: "Extra retained data",
    revision: sha256,
    sha256,
    asset: `library-extra-${sha256}.img`,
  };
  registry.images.push(image);
  registry.assets.push({ path: image.asset, bytes: bytes.length, sha256 });
  expect(
    registry.recipes.some((recipe) =>
      recipe.slots.some(
        (slot) => slot?.kind === "published" && slot.image.id === image.id,
      ),
    ),
  ).toBe(false);
  await page.route("**/disk-library-registry.json", (route) =>
    route.fulfill({ json: registry }),
  );
  let imageFetches = 0;
  await page.route(`**/${image.asset}`, (route) => {
    imageFetches++;
    return route.fulfill({
      body: bytes,
      contentType: "application/octet-stream",
    });
  });
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  await page.locator("#disk-library > summary").click();
  const row = page.locator(
    `[data-published-image-id="${image.id}"][data-published-image-revision="${image.revision}"]`,
  );
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Extra retained data");
  await expect(row).toContainText("protected");
  expect(imageFetches).toBe(0);
  await page.locator("#library-slot").selectOption("1");
  await page.locator("#library-ready").check();
  await row.getByRole("button", { name: "Insert", exact: true }).click();
  await expect.poll(() => imageFetches).toBeGreaterThanOrEqual(1);
  await expect
    .poll(() =>
      page.evaluate(
        async ({ id, sha256 }) => {
          const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open("triptych-cpu");
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          try {
            return await new Promise((resolve, reject) => {
              const tx = db.transaction([
                "disk-box-state-v1",
                "disk-box-blobs-v1",
              ]);
              const head = tx.objectStore("disk-box-state-v1").get("head");
              const copied = tx.objectStore("disk-box-blobs-v1").get(sha256);
              tx.oncomplete = () => {
                const manifest = head.result.manifest;
                const slot = manifest.configurations.find(
                  (row) => row.id === manifest.selectedConfigurationId,
                ).slots[1];
                resolve(
                  slot?.kind === "published" &&
                    slot.image.id === id &&
                    slot.image.sha256 === sha256 &&
                    copied.result === undefined,
                );
              };
              tx.onabort = () => reject(tx.error);
            });
          } finally {
            db.close();
          }
        },
        { id: image.id, sha256 },
      ),
    )
    .toBe(true);
  await page.locator("#files").click();
  await page.locator("#file-drive").selectOption("B");
  await page.locator("#close-files").click();
  const downloaded = page.waitForEvent("download");
  await page.locator("#download").click();
  const savedBytes = await readFile(await (await downloaded).path());
  expect(createHash("sha256").update(savedBytes).digest("hex")).toBe(sha256);
});
