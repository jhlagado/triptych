// Explicit integration gate: consume a captured all-profile builder run without
// repeating ATOM assembly. Each nNN directory contains descriptor.json,
// system.bin and bootstrap.bin. Missing fixtures fail this gate, never skip it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  fetchTwoMibSystem,
  admitTwoMibSavedMachine,
} from "../../crates/triptych-host-wasm/web/two-mib-system.js";

const directory = process.env.TRIPTYCH_TWO_MIB_FIXTURES;
assert.ok(
  directory,
  "TRIPTYCH_TWO_MIB_FIXTURES must identify a captured all-profile build",
);
const fixtures = [];
for (let count = 1; count <= 16; count++) {
  const path = join(directory, `n${String(count).padStart(2, "0")}`);
  fixtures.push({
    descriptor: JSON.parse(
      await readFile(join(path, "descriptor.json"), "utf8"),
    ),
    system: await readFile(join(path, "system.bin")),
    bootstrap: await readFile(join(path, "bootstrap.bin")),
  });
}
const deployment = {
  schema: "triptych-browser-deployment-v1",
  twoMibProfiles: fixtures.map((f) => f.descriptor),
  assets: fixtures.flatMap((f) =>
    ["system", "bootstrap"].map((kind) => ({
      path: f.descriptor[kind].asset,
      bytes: f.descriptor[kind].bytes,
      sha256: f.descriptor[kind].sha256,
    })),
  ),
};
const assets = new Map(
  fixtures.flatMap((f) =>
    ["system", "bootstrap"].map((kind) => [f.descriptor[kind].asset, f[kind]]),
  ),
);
for (let count = 1; count <= 16; count++)
  test(`real constructed tuple ${count} fetches and admits`, async () => {
    const fixture = fixtures[count - 1];
    const tuple = await fetchTwoMibSystem({
      configuredCount: count,
      deployment,
      baseUrl: "https://triptych.test/",
      crypto: webcrypto,
      fetch: async (url) =>
        new Response(assets.get(new URL(url).pathname.slice(1))),
    });
    assert.deepEqual(tuple.system, Uint8Array.from(fixture.system));
    assert.deepEqual(tuple.bootstrap, Uint8Array.from(fixture.bootstrap));
    const bytes = new Uint8Array(2097152);
    bytes.set(tuple.system);
    for (const offset of [0, 2048, 5632, 6656, 16383, 2097151])
      bytes[offset] ^= 1;
    const snapshot = {
      schema: "triptych-drive-set-v4",
      configuredCount: count,
      bootstrap: {
        profile: tuple.descriptor.residentProfile,
        bytes: tuple.bootstrap,
      },
      slots: Array.from({ length: count }, (_, index) =>
        index
          ? null
          : {
              instanceId: "12345678-1234-4123-8123-000000000001",
              name: "A",
              bytes,
            },
      ),
    };
    const admitted = await admitTwoMibSavedMachine({
      snapshot,
      deployment,
      crypto: webcrypto,
    });
    assert.equal(admitted.status, "admitted");
    assert.deepEqual(admitted.snapshot, snapshot);
  });

// Playwright is a development dependency. Route interception serves the exact
// local modules and captured assets in a secure browser origin; no server,
// repository build or listening port is needed for this isolated API gate.
test("real Chromium fetches n01/n16 and admits modified saved bytes without network", async () => {
  const { chromium } = createRequire(import.meta.url)("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const requested = [];
    await page.route("https://triptych.test/**", async (route) => {
      const name = new URL(route.request().url()).pathname.slice(1);
      requested.push(name);
      if (!name)
        return route.fulfill({
          contentType: "text/html",
          body: "<!doctype html><title>Two-MiB API proof</title>",
        });
      if (["two-mib-system.js", "drive-set-v4.js"].includes(name))
        return route.fulfill({
          contentType: "text/javascript",
          body: await readFile(
            new URL(
              `../../crates/triptych-host-wasm/web/${name}`,
              import.meta.url,
            ),
          ),
        });
      if (assets.has(name))
        return route.fulfill({
          contentType: "application/octet-stream",
          body: assets.get(name),
        });
      return route.fulfill({ status: 404, body: "unexpected request" });
    });
    await page.goto("https://triptych.test/");
    const results = await page.evaluate(async (deployment) => {
      const { fetchTwoMibSystem, admitTwoMibSavedMachine } =
        await import("./two-mib-system.js");
      const results = [];
      for (const count of [1, 16]) {
        const tuple = await fetchTwoMibSystem({
          deployment,
          configuredCount: count,
          baseUrl: location.href,
        });
        const bytes = new Uint8Array(2097152);
        bytes.set(tuple.system);
        for (const offset of [0, 2048, 5632, 6656, 16383, 2097151])
          bytes[offset] ^= 1;
        const snapshot = {
          schema: "triptych-drive-set-v4",
          configuredCount: count,
          bootstrap: {
            profile: tuple.descriptor.residentProfile,
            bytes: tuple.bootstrap,
          },
          slots: Array.from({ length: count }, (_, index) =>
            index
              ? null
              : {
                  instanceId: "12345678-1234-4123-8123-000000000001",
                  name: "A",
                  bytes,
                },
          ),
        };
        const before = new Uint8Array(bytes);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = () => {
          throw Error("saved admission must not fetch");
        };
        let admitted, unavailable;
        try {
          admitted = await admitTwoMibSavedMachine({ snapshot, deployment });
          unavailable = await admitTwoMibSavedMachine({
            snapshot,
            deployment: { schema: deployment.schema },
          });
        } finally {
          globalThis.fetch = originalFetch;
        }
        const exact = (copy) =>
          copy.length === before.length &&
          before.every((byte, index) => copy[index] === byte);
        const digest = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              admitted.snapshot.slots[0].bytes,
            ),
          ),
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
        results.push({
          count,
          status: admitted.status,
          unavailable: unavailable.code,
          digest,
          preserved:
            exact(admitted.snapshot.slots[0].bytes) &&
            exact(unavailable.snapshot.slots[0].bytes),
          owned: admitted.snapshot.slots[0].bytes.buffer !== bytes.buffer,
        });
      }
      return results;
    }, deployment);
    for (const result of results) {
      assert.equal(result.status, "admitted");
      assert.equal(result.unavailable, "PROFILE_UNAVAILABLE");
      assert.equal(result.preserved, true);
      assert.equal(result.owned, true);
      const bytes = Buffer.alloc(2097152);
      bytes.set(fixtures[result.count - 1].system);
      for (const offset of [0, 2048, 5632, 6656, 16383, 2097151])
        bytes[offset] ^= 1;
      assert.equal(
        result.digest,
        createHash("sha256").update(bytes).digest("hex"),
      );
    }
    assert.deepEqual(
      requested.filter((name) => name.endsWith(".bin")).sort(),
      [1, 16]
        .flatMap((count) =>
          ["system", "bootstrap"].map(
            (kind) => fixtures[count - 1].descriptor[kind].asset,
          ),
        )
        .sort(),
    );
  } finally {
    await browser.close();
  }
});
