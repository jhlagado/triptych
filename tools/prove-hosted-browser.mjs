import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";

// The directory must be the downloaded CI artifact, not a local rebuild.
const [address, directoryArgument, revision] = process.argv.slice(2);
assert.ok(
  address && directoryArgument && revision,
  "usage: node tools/prove-hosted-browser.mjs URL CI_ARTIFACT_DIRECTORY REVISION",
);
assert.match(revision, /^[0-9a-f]{40}$/);
const base = new URL(address.endsWith("/") ? address : `${address}/`);
assert.ok(
  base.protocol === "https:" ||
    (base.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(base.hostname)),
);
const directory = resolve(directoryArgument);
execFileSync(
  process.execPath,
  ["tools/check-browser-deployment.mjs", directory, revision, "--release"],
  { stdio: "inherit" },
);
const expectedManifest = await readFile(
  join(directory, "deployment-manifest.json"),
);
const manifest = JSON.parse(expectedManifest);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function download(name) {
  const response = await fetch(new URL(name, base), {
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  assert.ok(response.ok, `${name}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
assert.deepEqual(
  await download("deployment-manifest.json"),
  expectedManifest,
  "hosted manifest differs from CI artifact",
);
for (const asset of manifest.assets) {
  const bytes = await download(asset.path);
  assert.equal(bytes.length, asset.bytes, `${asset.path} hosted length`);
  assert.equal(digest(bytes), asset.sha256, `${asset.path} hosted digest`);
}

const browser = await chromium.launch();
try {
  // A new context cannot load or overwrite the user's saved browser disk.
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  const errors = [];
  const responseChecks = [];
  const seen = new Set();
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
      return;
    const name = url.pathname.slice(base.pathname.length) || "index.html";
    const asset = manifest.assets.find((entry) => entry.path === name);
    if (!asset) return;
    responseChecks.push(
      (async () => {
        assert.ok(response.ok(), `${name} browser HTTP ${response.status()}`);
        const bytes = await response.body();
        assert.equal(bytes.length, asset.bytes, `${name} browser length`);
        assert.equal(digest(bytes), asset.sha256, `${name} browser digest`);
        seen.add(name);
      })().catch((error) => errors.push(error.message)),
    );
  });
  page.on("pageerror", (error) => errors.push(error.message));
  const terminal = page.locator("#terminal");
  async function prompt() {
    await expect
      .poll(
        async () =>
          (await terminal.textContent())
            .split("\n")
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .at(-1),
        { timeout: 30_000 },
      )
      .toBe("A>");
  }
  async function send(command) {
    await terminal.focus();
    await page.keyboard.type(command);
    await page.keyboard.press("Enter");
  }
  async function command(value) {
    await send(value);
    await expect(terminal).toContainText(`A>${value}`);
    await prompt();
  }
  await page.goto(base.href);
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await prompt();
  await command("ATOM HELLO.ASM");
  await expect(terminal).toContainText("HELLO.COM written");
  await command("HELLO");
  await expect(terminal).toContainText("Hello from ATOM");
  await send("EDIT INPUT.NU");
  await expect(terminal).toContainText("^S Save  ^Q Quit");
  await page.keyboard.press("Control+f");
  await page.keyboard.type("'O'");
  await page.keyboard.press("Enter");
  await expect(terminal).toHaveAttribute("data-cursor-column", "21");
  await page.keyboard.press("Control+r");
  await page.keyboard.type("'Y'");
  await page.keyboard.press("Enter");
  await expect(terminal).toContainText("writeOutputByte('Y') else fail");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+q");
  await prompt();
  await command("NUC INPUT.NU");
  await command("INPUT");
  await expect(terminal).toContainText("YK");
  await expect(page.locator("#save-status")).toHaveText(
    "Working disk saved in this browser.",
  );
  await page.reload();
  await expect(page.locator("#status")).toContainText(
    "Running the restored working disk",
  );
  await prompt();
  await send("EDIT INPUT.NU");
  await expect(terminal).toContainText("writeOutputByte('Y') else fail");
  await expect(terminal).toContainText("^S Save  ^Q Quit");
  await page.keyboard.press("Control+q");
  await prompt();
  await command("INPUT");
  await expect(terminal).toContainText("YK");
  await Promise.all(responseChecks);
  for (const name of [
    "index.html",
    "app.js",
    "triptych_host_wasm.js",
    "triptych_host_wasm_bg.wasm",
    "config.json",
    "cpm22.img",
    "bootstrap.bin",
  ]) {
    assert.ok(seen.has(name), `browser did not load verified ${name}`);
  }
  assert.deepEqual(errors, [], "browser execution or asset identity errors");
  console.log(
    JSON.stringify({
      status: "passed",
      url: base.href,
      revision,
      assets: manifest.assets.length,
      diskSha256: manifest.distribution.disk.sha256,
      workflow: "ATOM/run, Edit/NUC/run/save/reload/reopen/run",
    }),
  );
} finally {
  await browser.close();
}
