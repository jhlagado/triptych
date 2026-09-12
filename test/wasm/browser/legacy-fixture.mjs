import { expect, test as base } from "@playwright/test";
import { encodeDiskBoxRecovery } from "../../../crates/triptych-host-wasm/web/disk-box-recovery.js";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

export { expect };

export async function seedLegacyDisk(
  page,
  { bytes, name = "triptych-cpm22.img" } = {},
) {
  bytes ??= new Uint8Array(
    await readFile(
      new URL("../../../dist/wasm-browser/cpm22.img", import.meta.url),
    ),
  );
  return seedHistoricalRecords(page, {
    version: 1,
    stores: [
      {
        name: "working-disks",
        keyPath: "key",
        records: [
          {
            value: {
              schema: "triptych-working-disk-v1",
              key: "drive-a",
              name,
              bytes,
            },
          },
        ],
      },
    ],
  });
}

/** Seed exact raw historical rows before any app is loaded.
 * stores: [{name, keyPath: string|null, records: [{key?, value}]}]. Omit key for
 * inline-key stores. No existing database is replaced or upgraded: callers must
 * use a fresh browser context. Corrupt records are intentionally accepted.
 * This leaves page on a blank same-origin document, with every DB handle closed.
 */
export async function seedHistoricalRecords(
  page,
  { version, stores, name = "triptych-cpu" },
) {
  if (![1, 2, 3, 4].includes(version))
    throw new Error("Historical seed version must be 1–4");
  if (
    !Array.isArray(stores) ||
    !stores.length ||
    new Set(stores.map((s) => s.name)).size !== stores.length
  )
    throw new Error("Historical seed needs distinct store definitions");
  for (const store of stores) {
    if (
      typeof store.name !== "string" ||
      !store.name ||
      !(store.keyPath === null || typeof store.keyPath === "string") ||
      !Array.isArray(store.records)
    )
      throw new Error("Invalid historical store definition");
  }
  // Binary archive transfer avoids decimal expansion of full 8MiB/16-drive
  // fixtures, and preserves raw corrupt records without invoking a publisher.
  const archive = await encodeDiskBoxRecovery(stores, { crypto: webcrypto });
  const encoded = Buffer.from(await archive.arrayBuffer()).toString("base64");
  const suffix = Math.random().toString(36).slice(2);
  const routePath = `**/historical-seed-${suffix}`;
  const codecPath = `**/historical-seed-codec-${suffix}.js`;
  const blankHandler = (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Historical seed only</title>",
    });
  const codecBody = await readFile(
    new URL(
      "../../../crates/triptych-host-wasm/web/disk-box-recovery.js",
      import.meta.url,
    ),
    "utf8",
  );
  const codecHandler = (route) =>
    route.fulfill({ contentType: "text/javascript", body: codecBody });
  await page.route(routePath, blankHandler);
  await page.route(codecPath, codecHandler);
  try {
    await page.goto(`/historical-seed-${suffix}`);
    return await page.evaluate(
      async ({ encoded, name, version, suffix }) => {
        const { decodeDiskBoxRecovery } = await import(
          `/historical-seed-codec-${suffix}.js`
        );
        const stores = await decodeDiskBoxRecovery(
          new Blob([Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))]),
        );
        return new Promise((resolve, reject) => {
          const request = indexedDB.open(name, version);
          let created = false;
          request.onblocked = () =>
            reject(
              new Error(
                "Historical seed blocked: close existing database users",
              ),
            );
          request.onupgradeneeded = (event) => {
            if (event.oldVersion !== 0) {
              request.transaction.abort();
              return;
            }
            created = true;
            try {
              for (const definition of stores) {
                const store = request.result.createObjectStore(
                  definition.name,
                  definition.keyPath === null
                    ? undefined
                    : { keyPath: definition.keyPath },
                );
                for (const row of definition.records) {
                  if (Object.hasOwn(row, "key")) store.add(row.value, row.key);
                  else store.add(row.value);
                }
              }
            } catch (error) {
              request.transaction.abort();
              reject(error);
            }
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            db.close();
            if (!created)
              reject(new Error("Historical seed refuses an existing database"));
            else resolve({ name, version, stores: stores.map((s) => s.name) });
          };
        });
      },
      { encoded, name, version, suffix },
    );
  } finally {
    await page.unroute(routePath, blankHandler);
    await page.unroute(codecPath, codecHandler);
  }
}

/** Adoption is an explicit tested action, never an automatic page fixture. */
export async function adoptHistoricalMachine(
  page,
  { url = "/", navigate = true } = {},
) {
  if (navigate) await page.goto(url);
  await expect(page.locator("#adopt-disks")).toBeVisible();
  await expect(page.locator("#status")).toContainText(
    "explicit disk-box adoption",
  );
  await page.locator("#adopt-disks").click();
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await expect(page.locator("#adopt-disks")).toBeHidden();
}

/** Current DB5 authority plus the Files byte view, using a non-owning reader.
 * This deliberately never opens the historical v4 publisher after startup.
 * The return value crosses Playwright serialization; summarize/hash large byte
 * snapshots within page.evaluate in callers needing compact comparisons.
 */
export async function inspectDiskBox(
  page,
  { name = "triptych-cpu", includeSnapshot = false } = {},
) {
  return page.evaluate(
    async ({ name, includeSnapshot }) => {
      const open = includeSnapshot
        ? (await import("/disk-box-app-store.js")).openDiskBoxAppStore
        : (await import("/disk-box-store.js")).openDiskBoxStore;
      const store = await open({ name, lease: { isOwner: () => false } });
      try {
        const loaded = await store.load();
        if (loaded.kind !== "ready") return loaded;
        return {
          kind: loaded.kind,
          token: loaded.token,
          manifest: loaded.manifest,
          ...(includeSnapshot ? { snapshot: loaded.snapshot } : {}),
          backups: await store.listBackups(),
        };
      } finally {
        store.close();
      }
    },
    { name, includeSnapshot },
  );
}

// Compatibility only: this route does not select a historical startup on DB5.
// Port callers to seedHistoricalRecords + adoptHistoricalMachine explicitly.
export async function useLegacyConfiguration(page) {
  const handler = (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        diskUrl: "cpm22.img",
        diskName: "triptych-cpm22.img",
        systemCcp: "triptych",
      }),
    });
  await page.route("**/config.json", handler);
  return async () => {
    if (!page.isClosed()) await page.unroute("**/config.json", handler);
  };
}

export const test = base.extend({
  legacyConfiguration: [
    async ({ page }, use) => {
      const removeRoute = await useLegacyConfiguration(page);
      await use();
      await removeRoute();
    },
    { auto: true },
  ],
});
