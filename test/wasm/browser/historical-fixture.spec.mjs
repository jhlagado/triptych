import { test, expect } from "@playwright/test";
import { seedHistoricalRecords } from "./legacy-fixture.mjs";

for (const version of [1, 2, 3, 4]) {
  test(`preboot historical fixture preserves raw version ${version} without starting the app`, async ({
    page,
  }) => {
    const name = `historical-fixture-${version}`;
    const stores = [
      {
        name: "historical-opaque",
        keyPath: "key",
        records: [
          {
            value: {
              key: "head",
              schema: "intentionally corrupt",
              bytes: Uint8Array.of(0, 255, version),
              extra: [null, "unchanged"],
            },
          },
        ],
      },
      {
        name: "out-of-line",
        keyPath: null,
        records: [{ key: "opaque-key", value: Uint8Array.of(17) }],
      },
    ];
    await seedHistoricalRecords(page, { version, name, stores });
    expect(await page.title()).toBe("Historical seed only");
    expect(await page.locator("#terminal").count()).toBe(0);
    const raw = await page.evaluate(async (name) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      try {
        return await new Promise((resolve, reject) => {
          const tx = db.transaction([...db.objectStoreNames], "readonly");
          const head = tx.objectStore("historical-opaque").get("head");
          const keyed = tx.objectStore("out-of-line").get("opaque-key");
          tx.oncomplete = () =>
            resolve({
              version: db.version,
              stores: [...db.objectStoreNames],
              head: { ...head.result, bytes: Array.from(head.result.bytes) },
              keyed: Array.from(keyed.result),
            });
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    }, name);
    expect(raw).toEqual({
      version,
      stores: ["historical-opaque", "out-of-line"],
      head: {
        key: "head",
        schema: "intentionally corrupt",
        bytes: [0, 255, version],
        extra: [null, "unchanged"],
      },
      keyed: [17],
    });
    await expect(
      seedHistoricalRecords(page, { version, name, stores }),
    ).rejects.toThrow(/existing database/);
  });
}
