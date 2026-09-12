import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { captureDiskLibraryRelease } from "../../../tools/lib/disk-library-release.mjs";
import { mergeDiskLibraryRetention } from "../../../tools/lib/disk-library-retention.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
const selected = (manifest) =>
  manifest.configurations.find(
    (row) => row.id === manifest.selectedConfigurationId,
  );

async function releases(request) {
  const manifest = await (
    await request.get("/disk-library-registry.json")
  ).json();
  const assets = new Map(
    await Promise.all(
      manifest.assets.map(async (row) => {
        const response = await request.get(`/${row.path}`);
        expect(response.ok()).toBe(true);
        return [row.path, Buffer.from(await response.body())];
      }),
    ),
  );
  const reference = manifest.defaults.find((row) => row.id === "starter");
  const recipe = manifest.recipes.find(
    (row) => row.id === reference.id && row.revision === reference.revision,
  );
  const admission = manifest.admissions.find(
    (row) => row.id === recipe.admission,
  );
  const images = [recipe.slots[0], recipe.slots[2]].map((slot) =>
    structuredClone(
      manifest.images.find(
        (row) =>
          row.id === slot.image.id && row.revision === slot.image.revision,
      ),
    ),
  );
  const provenance = JSON.parse(assets.get(recipe.provenance));
  const { CpmDisk } = createRequire(import.meta.url)(
    "../../../dist/wasm/triptych_host_wasm.js",
  );
  const disk = new CpmDisk(assets.get(images[1].asset));
  let upgradedGames;
  try {
    disk.add_import("NEW.TXT", Buffer.from("New library release sentinel\r\n"));
    upgradedGames = disk.export_candidate();
  } finally {
    disk.free();
  }
  const verified = new CpmDisk(upgradedGames);
  try {
    expect(Buffer.from(verified.read_file("NEW.TXT")).toString()).toContain(
      "New library release sentinel",
    );
  } finally {
    verified.free();
  }
  const oldGames = { ...images[1] };
  Object.assign(images[1], {
    sha256: hash(upgradedGames),
    revision: hash(upgradedGames),
    asset: `library-games-2m-${hash(upgradedGames)}.img`,
  });
  const proof = provenance.images.find((row) => row.asset === oldGames.asset);
  Object.assign(proof, {
    asset: images[1].asset,
    sha256: images[1].sha256,
    bytes: upgradedGames.length,
  });
  proof.files = [
    ...(proof.files ?? []),
    {
      name: "NEW.TXT",
      bytes: Buffer.byteLength("New library release sentinel\r\n"),
      sha256: hash(Buffer.from("New library release sentinel\r\n")),
    },
  ];
  // Synthetic release provenance records the test-only file addition, without
  // claiming a changed OS, new component build or resident qualification.
  provenance.testLibraryChange = {
    added: "NEW.TXT",
    sha256: hash(Buffer.from("New library release sentinel\r\n")),
  };
  const sources = new Map(
    admission.bindings.map((row) => [row.path, assets.get(row.asset)]),
  );
  sources.set(images[0].asset, assets.get(images[0].asset));
  sources.set(images[1].asset, upgradedGames);
  const next = captureDiskLibraryRelease({
    catalogueBytes: json({ schema: "triptych-disk-catalogue-v1", images }),
    provenanceBytes: json(provenance),
    admissionBytes: assets.get(admission.envelope),
    assets: sources,
    blankSeed: assets.get(
      recipe.slots.find((slot) => slot?.kind === "writable-role").seed.asset,
    ),
  });
  const old = { manifest, assets };
  const merged = mergeDiskLibraryRetention(old, next, {
    defaults: next.manifest.defaults,
  });
  expect(next.manifest.admissions[0].id).toBe(admission.id);
  expect(next.manifest.images[0]).toEqual(images[0]);
  expect(images[1].sha256).not.toBe(oldGames.sha256);
  return {
    old,
    merged,
    oldRecipe: reference,
    oldGames,
    newGames: images[1],
    bootstrap: recipe.bootstrap,
    seed: recipe.slots[1].seed.asset,
  };
}

async function state(page, diskId) {
  return page.evaluate(async (diskId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("triptych-cpu");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const value = await new Promise((resolve, reject) => {
        const tx = db.transaction(["disk-box-state-v1", "disk-box-blobs-v1"]);
        const head = tx.objectStore("disk-box-state-v1").get("head");
        const keys = tx.objectStore("disk-box-blobs-v1").getAllKeys();
        let blob;
        head.onsuccess = () => {
          if (diskId) {
            const disk = head.result.manifest.personalDisks.find(
              (row) => row.id === diskId,
            );
            blob = tx.objectStore("disk-box-blobs-v1").get(disk.content.sha256);
          }
        };
        tx.oncomplete = () =>
          resolve({
            manifest: head.result.manifest,
            blobs: keys.result,
            bytes: blob?.result?.bytes,
          });
        tx.onabort = () => reject(tx.error);
      });
      if (diskId) {
        const { CpmDisk } = await import("/triptych_host_wasm.js");
        const disk = new CpmDisk(value.bytes);
        try {
          value.file = Array.from(disk.read_file("KEEP.TXT"));
        } finally {
          disk.free();
        }
      }
      delete value.bytes;
      return value;
    } finally {
      db.close();
    }
  }, diskId);
}

test("old recipe and personal work survive a new games default; new setup remains independent", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180000);
  const release = await releases(request);
  let active = release.old;
  const fetched = [];
  const serve = async (route) => {
    const path = new URL(route.request().url()).pathname.split("/").at(-1);
    if (path === "disk-library-registry.json")
      return route.fulfill({ json: active.manifest });
    const bytes = active.assets.get(path);
    if (!bytes) return route.continue();
    fetched.push(path);
    return route.fulfill({
      body: Buffer.from(bytes),
      contentType: path.endsWith(".json")
        ? "application/json"
        : "application/octet-stream",
    });
  };
  await page.route("**/*", serve);
  const oldRoute = `/?recipe=${release.oldRecipe.id}&revision=${release.oldRecipe.revision}`;
  await page.goto(oldRoute);
  await expect(page.locator("#terminal")).toContainText("A>");
  page.on("dialog", (dialog) => dialog.accept());
  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await page.locator("#file-drive").selectOption("B");
  const sentinel = Buffer.from("Keep my original personal work\r\n");
  await page.locator("#file-import").setInputFiles({
    name: "KEEP.TXT",
    mimeType: "text/plain",
    buffer: sentinel,
  });
  await expect(page.locator("#files-status")).toContainText("Staged KEEP.TXT");
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
  await page.locator("#close-files").click();
  const initial = await state(page);
  const oldConfiguration = selected(initial.manifest);
  const workId = oldConfiguration.slots[1].diskId;
  const saved = await state(page, workId);
  expect(Buffer.from(saved.file).subarray(0, sentinel.length)).toEqual(
    sentinel,
  );
  expect(oldConfiguration.slots[2].image.sha256).toBe(release.oldGames.sha256);

  active = release.merged;
  fetched.length = 0;
  await page.goto(oldRoute);
  await expect(page.locator("#terminal")).toContainText("A>");
  expect(await state(page, workId)).toEqual(saved);
  expect(fetched).not.toContain(release.bootstrap);
  expect(fetched).not.toContain(release.seed);
  expect(selected((await state(page)).manifest).slots[2].image.sha256).toBe(
    release.oldGames.sha256,
  );

  // Leave the explicit old preview before choosing the new default setup.
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
  await page.locator("#disk-library > summary").click();
  const nextReference = release.merged.manifest.defaults.find(
    (row) => row.id === "starter",
  );
  await expect(page.locator("#share-starter")).toHaveAttribute(
    "href",
    `?recipe=starter&revision=${nextReference.revision}`,
  );
  await page.locator("#library-ready").check();
  await page.locator("#launch-starter").click();
  await expect
    .poll(
      async () => selected((await state(page)).manifest).slots[2].image.sha256,
    )
    .toBe(release.newGames.sha256);
  const upgraded = await state(page, workId);
  expect(
    upgraded.manifest.configurations.find(
      (row) => row.id === oldConfiguration.id,
    ),
  ).toEqual(oldConfiguration);
  expect(upgraded.file).toEqual(saved.file);
  expect(upgraded.manifest.personalDisks.length).toBe(
    saved.manifest.personalDisks.length + 2,
  );
  expect(selected(upgraded.manifest).slots[1].diskId).not.toBe(workId);

  const fresh = await browser.newContext();
  try {
    const oldPage = await fresh.newPage();
    await oldPage.route("**/*", serve);
    await oldPage.goto(new URL(oldRoute, page.url()).href);
    await expect(oldPage.locator("#terminal")).toContainText("A>");
    const revived = await state(oldPage);
    expect(selected(revived.manifest).slots[2].image.sha256).toBe(
      release.oldGames.sha256,
    );
    expect(revived.manifest.personalDisks).toHaveLength(2);
    expect(selected(revived.manifest).slots[1].diskId).not.toBe(workId);
  } finally {
    await fresh.close();
  }
});
