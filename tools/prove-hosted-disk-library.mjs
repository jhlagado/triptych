// Public-site acceptance only. Consumes a downloaded CI artifact; never builds,
// serves, substitutes responses, or connects to an existing browser profile.
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { chromium, expect } from "@playwright/test";
import { decodeDiskBoxRecovery } from "../crates/triptych-host-wasm/web/disk-box-recovery.js";

const [address, artifactDirectory, revision, ...extra] = process.argv.slice(2);
assert(
  address && artifactDirectory && revision && !extra.length,
  "usage: node tools/prove-hosted-disk-library.mjs URL CI_ARTIFACT_DIR EXACT_REV",
);
assert.match(revision, /^[a-f0-9]{40}$/);
const base = new URL(address.endsWith("/") ? address : `${address}/`);
assert(!base.username && !base.password && !base.search && !base.hash);
assert(
  base.protocol === "https:" ||
    (base.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(base.hostname)),
);
const directory = resolve(artifactDirectory);
execFileSync(
  process.execPath,
  [
    resolve(import.meta.dirname, "check-browser-deployment.mjs"),
    directory,
    revision,
    "--release",
    "--require-two-mib",
  ],
  { stdio: "inherit" },
);
const expectedManifest = await readFile(
  join(directory, "deployment-manifest.json"),
);
const manifest = JSON.parse(expectedManifest);
assert.equal(manifest.storageSchema, "triptych-disk-box-v1");
assert.equal(manifest.distribution.triptych.revision, revision);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const assets = new Map(manifest.assets.map((row) => [row.path, row]));
async function fetched(path, expectedLength) {
  const response = await fetch(new URL(path, base), {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  assert(response.ok, `${path}: HTTP ${response.status}`);
  const chunks = [];
  let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    assert(length <= expectedLength, `${path}: oversized response`);
    chunks.push(chunk);
  }
  assert.equal(length, expectedLength, `${path}: truncated response`);
  return Buffer.concat(chunks, length);
}
assert.deepEqual(
  await fetched("deployment-manifest.json", expectedManifest.length),
  expectedManifest,
);
for (const asset of manifest.assets) {
  assert.match(asset.path, /^[A-Za-z0-9_.-]+$/);
  assert(
    asset.path !== "." &&
      asset.path !== ".." &&
      asset.path !== "deployment-manifest.json",
  );
  const expected = await readFile(join(directory, asset.path));
  assert.equal(expected.length, asset.bytes);
  assert.equal(hash(expected), asset.sha256);
  assert.deepEqual(
    await fetched(asset.path, asset.bytes),
    expected,
    `${asset.path}: hosted bytes differ from CI`,
  );
}
console.log(
  `Verified exact hosted deployment and ${assets.size} assets against CI ${revision}.`,
);

const browser = await chromium.launch();
const contexts = [],
  observed = [],
  failures = [],
  checks = [];
const pageChecks = new WeakMap();
try {
  async function pageFor(label, mobile = false) {
    const context = await browser.newContext({
      serviceWorkers: "block",
      ...(mobile
        ? {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
          }
        : {}),
    });
    contexts.push(context);
    const page = await context.newPage();
    page.setDefaultTimeout(30000);
    page.on("dialog", (dialog) => dialog.accept());
    page.on("pageerror", (error) =>
      failures.push(`${label}: ${error.message}`),
    );
    const seen = new Set();
    const pending = [];
    const session = await context.newCDPSession(page);
    await session.send("Network.enable", {
      maxResourceBufferSize: 16 * 1024 * 1024,
      maxTotalBufferSize: 128 * 1024 * 1024,
    });
    await session.send("Network.setCacheDisabled", { cacheDisabled: true });
    pageChecks.set(page, pending);
    observed.push({ label, seen });
    session.on(
      "Fetch.requestPaused",
      ({ requestId, request, responseStatusCode }) => {
        const url = new URL(request.url);
        const path = url.pathname.slice(base.pathname.length) || "index.html";
        const asset = assets.get(path);
        const check = (async () => {
          try {
            if (!asset && path !== "deployment-manifest.json") return;
            assert(
              responseStatusCode >= 200 && responseStatusCode < 300,
              `${label}/${path}: HTTP ${responseStatusCode}`,
            );
            // Pause delivery, read THIS original server response, then continue
            // it unchanged. No second fetch, fulfillment, header or body override.
            // This avoids Chromium discarding consumed Fetch stream bodies.
            const body = await session.send("Fetch.getResponseBody", {
              requestId,
            });
            const bytes = Buffer.from(
              body.body,
              body.base64Encoded ? "base64" : "utf8",
            );
            if (asset) {
              assert.equal(
                bytes.length,
                asset.bytes,
                `${label}/${path}: length`,
              );
              assert.equal(
                hash(bytes),
                asset.sha256,
                `${label}/${path}: digest`,
              );
            } else assert.deepEqual(bytes, expectedManifest);
            seen.add(path);
          } finally {
            await session.send("Fetch.continueResponse", { requestId });
          }
        })().catch((error) =>
          failures.push(`${label}/${path}: ${error.message}`),
        );
        pending.push(check);
        checks.push(check);
      },
    );
    await session.send("Fetch.enable", {
      patterns: [{ urlPattern: `${base.href}*`, requestStage: "Response" }],
    });
    return page;
  }
  async function prompt(page, suffix = "A>") {
    await expect
      .poll(
        async () =>
          (await page.locator("#terminal").textContent())
            .trimEnd()
            .endsWith(suffix),
        { timeout: 30000 },
      )
      .toBe(true);
  }
  async function drainResponses(page) {
    // A response event precedes completion of its body. Navigation can discard
    // Chromium's body buffer, so finish every check before leaving this page.
    const pending = pageChecks.get(page);
    let count;
    do {
      await page.waitForLoadState("networkidle");
      count = pending.length;
      await Promise.all(pending);
    } while (pending.length !== count);
    assert.deepEqual(
      failures,
      [],
      "browser response verification failed before navigation",
    );
  }
  async function boot(page, url = base.href) {
    if (page.url() !== "about:blank") await drainResponses(page);
    await page.goto(url);
    await expect(page.locator("#status")).toHaveAttribute(
      "data-state",
      "running",
    );
    await prompt(page);
    await page.waitForLoadState("networkidle");
  }
  async function library(page) {
    if (
      !(await page.locator("#disk-library").evaluate((element) => element.open))
    )
      await page.locator("#disk-library summary").click();
    await expect(page.locator("#share-starter")).toHaveAttribute(
      "href",
      /revision=[a-f0-9]{64}$/,
    );
  }
  async function command(page, text, suffix = "?") {
    const terminal = page.locator("#terminal"),
      before = await terminal.textContent();
    await terminal.focus();
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () => {
          const after = await terminal.textContent();
          return after !== before && after.trimEnd().endsWith(suffix);
        },
        { timeout: 30000 },
      )
      .toBe(true);
    return terminal.textContent();
  }
  // Read-only inspection of this script's disposable context, not a user DB.
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
  const configuration = (value) =>
    value.manifest.configurations.find(
      (row) => row.id === value.manifest.selectedConfigurationId,
    );
  function protectedDisksUncopied(value) {
    for (const config of value.manifest.configurations)
      for (const slot of config.slots.filter(
        (slot) => slot?.kind === "published",
      ))
        assert(
          !value.blobs.includes(slot.image.sha256),
          "published disk copied into personal blob storage",
        );
  }
  function publicLink(href) {
    const link = new URL(href, base);
    assert.equal(link.origin, base.origin);
    assert.deepEqual([...link.searchParams.keys()].sort(), [
      "recipe",
      "revision",
    ]);
    assert.match(link.searchParams.get("revision"), /^[a-f0-9]{64}$/);
    return link.href;
  }
  const desktop = await pageFor("desktop");
  await boot(desktop);
  await library(desktop);
  const initial = await state(desktop),
    original = configuration(initial);
  assert.equal(original.configuredCount, 4);
  assert.deepEqual(
    original.slots.map((slot) => slot.kind),
    ["published", "personal", "published", "personal"],
  );
  assert(original.slots[1].writable && original.slots[3].writable);
  assert.notEqual(original.slots[1].diskId, original.slots[3].diskId);
  assert.equal(initial.manifest.personalDisks.length, 2);
  protectedDisksUncopied(initial);
  const starterLink = publicLink(
    await desktop.locator("#share-starter").getAttribute("href"),
  );
  const libraryLink = publicLink(
    await desktop.locator("#share-library").getAttribute("href"),
  );
  console.log("Fresh protected A/C and independent writable B/D verified.");

  async function gameStart(page, game) {
    await command(
      page,
      `C:${game}`,
      game === "CAVERNS" ? "[Space/Enter: more, Q: skip]" : "?",
    );
    if (game === "CAVERNS") {
      await page.keyboard.type("q");
      await prompt(page, "?");
    }
  }
  async function inventory(page) {
    const text = await command(page, "INVENTORY");
    return text.slice(text.lastIndexOf("INVENTORY")).replace(/\r/g, "").trim();
  }
  async function quit(page, game) {
    await command(
      page,
      "QUIT",
      game === "CAVERNS" ? "Another adventure?" : "Return to CP/M? (Y/N)",
    );
    await command(page, game === "CAVERNS" ? "N" : "Y", "D>");
  }
  await command(desktop, "D:", "D>");
  const savedInventories = {};
  for (const game of ["CAVERNS", "HYPERDRV"]) {
    await gameStart(desktop, game);
    await command(desktop, "TAKE COMPASS");
    savedInventories[game] = await inventory(desktop);
    assert.match(savedInventories[game], /compass/i);
    await command(desktop, "SAVE");
    await command(desktop, "DROP COMPASS");
    assert.doesNotMatch(await inventory(desktop), /compass/i);
    await command(desktop, "LOAD");
    assert.equal(await inventory(desktop), savedInventories[game]);
    await quit(desktop, game);
  }
  // The management barrier acknowledges the complete writable checkpoint.
  await desktop.locator("#library-ready").check();
  await desktop.locator("#library-name").fill("Hosted acceptance ejected disk");
  await desktop.locator("#library-blank").click();
  await expect
    .poll(async () => (await state(desktop)).manifest.personalDisks.length)
    .toBe(3);
  const saved = await state(desktop);
  assert.deepEqual(configuration(saved).slots[0], original.slots[0]);
  assert.deepEqual(configuration(saved).slots[2], original.slots[2]);
  assert.deepEqual(
    saved.manifest.personalDisks.find(
      (row) => row.id === original.slots[1].diskId,
    ),
    initial.manifest.personalDisks.find(
      (row) => row.id === original.slots[1].diskId,
    ),
  );
  await boot(desktop);
  await command(desktop, "D:", "D>");
  for (const game of ["CAVERNS", "HYPERDRV"]) {
    await gameStart(desktop, game);
    assert.doesNotMatch(await inventory(desktop), /compass/i);
    await command(desktop, "LOAD");
    assert.equal(await inventory(desktop), savedInventories[game]);
    await quit(desktop, game);
  }
  console.log(
    "Both games SAVE/LOAD changed inventory across reload on private D.",
  );

  await library(desktop);
  const extraDisk = saved.manifest.personalDisks.find(
    (row) => row.name === "Hosted acceptance ejected disk",
  );
  await desktop.locator("#library-slot").selectOption("1");
  await desktop.locator("#library-ready").check();
  await desktop
    .locator(`[data-disk-id="${extraDisk.id}"]`)
    .getByRole("button", { name: "Insert", exact: true })
    .click();
  await expect
    .poll(async () => configuration(await state(desktop)).slots[1]?.diskId)
    .toBe(extraDisk.id);
  await prompt(desktop, "D>"); // A CPU reboot would have returned to A>.
  await command(desktop, "DIR", "D>");
  await desktop.locator("#library-ready").check();
  await desktop.locator("#library-eject").click();
  await expect
    .poll(async () => configuration(await state(desktop)).slots[1])
    .toBeNull();
  await prompt(desktop, "D>");
  await command(desktop, "DIR", "D>");
  const ejected = await state(desktop);
  await boot(desktop, starterLink);
  assert.deepEqual(
    await state(desktop),
    ejected,
    "public recipe revisit reseeded or remounted private media",
  );
  await library(desktop);
  const localLink = new URL(
    await desktop.locator("#local-configuration-bookmark").getAttribute("href"),
    base,
  ).href;
  assert.equal(
    new URL(localLink).searchParams.get("configuration"),
    original.id,
  );
  assert(!new URL(localLink).searchParams.has("recipe"));
  await desktop.locator("#library-ready").check();
  await desktop.locator("#launch-fresh").click();
  await expect
    .poll(async () => (await state(desktop)).manifest.configurations.length)
    .toBe(2);
  await boot(desktop, localLink);
  const returned = await state(desktop);
  assert.equal(returned.manifest.selectedConfigurationId, original.id);
  assert.deepEqual(configuration(returned), configuration(ejected));
  for (const disk of ejected.manifest.personalDisks)
    assert.deepEqual(
      returned.manifest.personalDisks.find((row) => row.id === disk.id),
      disk,
    );
  protectedDisksUncopied(returned);
  console.log(
    "Live B insert/eject retained running D; ejected disks and public/local instance reuse verified.",
  );

  await library(desktop);
  const downloading = desktop.waitForEvent("download");
  await desktop.locator("#library-backup").click();
  const backup = await downloading;
  assert.match(backup.suggestedFilename(), /\.tdbr$/);
  const decoded = await decodeDiskBoxRecovery(
    new Blob([await readFile(await backup.path())]),
    { crypto: webcrypto },
  );
  const rawHead = decoded["disk-box-state-v1"].find(
    (row) => row.key === "head",
  );
  assert.deepEqual(rawHead.manifest, returned.manifest);
  for (const row of decoded["disk-box-blobs-v1"])
    assert.equal(hash(row.bytes), row.sha256);
  assert.deepEqual(
    decoded["disk-box-blobs-v1"].map((row) => row.sha256).sort(),
    [...returned.blobs].sort(),
  );
  assert(rawHead.manifest.personalDisks.some((row) => row.id === extraDisk.id));
  console.log(
    "Downloaded complete recovery archive decodes with exact head and hash-valid ejected/private media.",
  );

  const protectedPage = await pageFor("protected-only");
  await boot(protectedPage, libraryLink);
  const protectedState = await state(protectedPage);
  assert.equal(protectedState.manifest.personalDisks.length, 0);
  assert.equal(protectedState.blobs.length, 0);
  assert.deepEqual(
    configuration(protectedState).slots.map((slot) => slot?.kind ?? null),
    ["published", null, "published", null],
  );
  await command(protectedPage, "DIR", "A>");
  await library(protectedPage);
  const protectedConfiguration = configuration(protectedState);
  await protectedPage.locator("#library-slot").selectOption("0");
  await protectedPage.locator("#library-ready").check();
  await protectedPage.locator("#library-eject").click();
  await expect
    .poll(async () => configuration(await state(protectedPage)).slots[0])
    .toBeNull();
  assert.deepEqual(
    configuration(await state(protectedPage)).systemDisk,
    protectedConfiguration.systemDisk,
  );
  await expect(protectedPage.locator("#reset")).toBeEnabled();
  await protectedPage.locator("#reset").click();
  await expect(protectedPage.locator("#status")).toHaveAttribute(
    "data-state",
    "recovery",
  );
  await expect(protectedPage.locator("#restore-system-disk")).toBeVisible();
  const blocked = await state(protectedPage);
  assert.equal(configuration(blocked).slots[0], null);
  assert.equal(blocked.manifest.personalDisks.length, 0);
  assert.equal(blocked.blobs.length, 0);
  await protectedPage.locator("#library-ready").check();
  await protectedPage.locator("#restore-system-disk").click();
  await expect(protectedPage.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await prompt(protectedPage);
  await command(protectedPage, "DIR", "A>");
  const restored = await state(protectedPage);
  assert.deepEqual(configuration(restored).slots, protectedConfiguration.slots);
  assert.deepEqual(
    configuration(restored).systemDisk,
    protectedConfiguration.systemDisk,
  );
  assert.equal(restored.manifest.personalDisks.length, 0);
  assert.equal(restored.blobs.length, 0);
  console.log(
    "Protected A ejection blocks reset; explicit exact-system restoration resumes fresh commands with zero personal blobs.",
  );

  const mobile = await pageFor("mobile", true);
  await boot(mobile);
  const mobileScreen = await mobile.locator("#terminal").textContent();
  await mobile.locator("#show-keyboard").tap();
  await expect(mobile.locator("#mobile-terminal-input")).toBeFocused();
  await mobile.keyboard.type("DIR");
  await mobile.keyboard.press("Enter");
  await expect
    .poll(() => mobile.locator("#terminal").textContent())
    .not.toBe(mobileScreen);
  await prompt(mobile);
  assert.equal(configuration(await state(mobile)).configuredCount, 4);
  for (const context of contexts)
    for (const page of context.pages()) await drainResponses(page);
  await Promise.all(checks);
  assert.deepEqual(
    failures,
    [],
    "browser execution or fetched-byte identity failure",
  );
  for (const { label, seen } of observed)
    for (const asset of [
      "index.html",
      "app.js",
      "triptych_host_wasm_bg.wasm",
      "disk-library-registry.json",
    ])
      assert(
        seen.has(asset),
        `${label}: actual ${asset} response not verified`,
      );
  console.log(
    "PASS: hosted disk library, protected-only zero blobs, desktop and mobile real-UI acceptance.",
  );
  console.log(
    "Scope excludes simulated release upgrades, destructive/crash injection, and non-Chromium engines; those remain separate tests.",
  );
} finally {
  for (const context of contexts) await context.close();
  await browser.close();
}
