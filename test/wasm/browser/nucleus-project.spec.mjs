import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { readCpm22File } from "../../../tools/lib/cpm22-disk.mjs";

async function manage(page) {
  await page.locator("#files").click();
  await page.locator("#saved-and-exited").check();
  await page.locator("#begin-management").click();
  await expect(page.locator("#file-import")).toBeEnabled();
}
async function boot(page) {
  await page.goto("/");
  await expect(page.locator("#terminal")).toContainText("A>");
}
async function apply(page) {
  await page.locator("#commit-disk").click();
  await expect(page.locator("#files-status")).toContainText("Disk committed");
}
async function command(page, value) {
  await page.locator("#terminal").focus();
  await page.keyboard.type(value);
  await page.keyboard.press("Enter");
}
async function runCommand(page, value) {
  const before = await page.locator("#terminal").textContent();
  await command(page, value);
  await expect
    .poll(() => page.locator("#terminal").textContent())
    .not.toBe(before);
  await expect
    .poll(async () => {
      const text = await page.locator("#terminal").textContent();
      return text.includes(`A>${value}`) && text.trimEnd().endsWith("A>");
    })
    .toBe(true);
}
async function savedBytes(page) {
  return page.evaluate(async () => {
    const { openDriveSetStore } = await import("/drive-set-store.js");
    const store = await openDriveSetStore();
    try {
      return Array.from((await store.load()).snapshot.drives.A.bytes);
    } finally {
      store.close();
    }
  });
}
async function nativeReopen(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cargo",
      [
        "run",
        "--quiet",
        "--locked",
        "-p",
        "triptych-host-native",
        "--",
        "--stop-after",
        "Bye.\r\n\r\nA>",
        "--max-steps",
        "200000000",
        "dist/wasm-browser/bootstrap.bin",
        path,
      ],
      { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      errorOutput = "",
      phase = 0;
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on("data", (bytes) => {
      output += bytes.toString();
      // Boot discards pre-prompt input; interact at actual output boundaries.
      if (phase === 0 && output.endsWith("\r\nA>")) {
        phase = 1;
        child.stdin.write("GAME\r");
      } else if (phase === 1 && output.includes("BASE> ")) {
        phase = 2;
        child.stdin.write("Q");
      }
    });
    child.stderr.on("data", (bytes) => {
      errorOutput += bytes.toString();
    });
    child.on("error", reject);
    child.stdin.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && phase === 2) resolve(output);
      else reject(new Error(`Native reopen failed: ${errorOutput}\n${output}`));
    });
  });
}

test("project rejects names that NUC would overwrite", async ({ page }) => {
  await boot(page);
  await manage(page);
  const before = await savedBytes(page);
  page.on("dialog", (dialog) => dialog.accept());
  for (const name of ["GAME.COM", "GAME.BAK", "GAME.$$$"]) {
    await page.locator("#file-import").setInputFiles([
      {
        name: "BUILD.JSN",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            schema: "triptych-nucleus-project-v1",
            sources: [name],
            output: "GAME.NU",
            sourceMap: "GAME.MAP",
          }),
        ),
      },
      {
        name,
        mimeType: "text/plain",
        buffer: Buffer.from("sub main()\nend\n"),
      },
    ]);
    await expect(page.locator("#files-status")).toContainText("Staged");
    await page.locator("#prepare-build").click();
    await expect(page.locator("#files-status")).toContainText(
      "compiler output",
    );
    expect(await savedBytes(page)).toEqual(before);
  }
});

test("adventure edit/build/update/reload/download/reopen preserves its separate sources", async ({
  page,
  browser,
}, info) => {
  page.on("dialog", (dialog) => dialog.accept());
  await boot(page);
  await manage(page);
  await page.locator("#stage-adventure").click();
  await expect(page.locator("#files-status")).toContainText(
    "Staged IO.NU, MAIN.NU, BUILD.JSN",
  );
  await page.locator("#prepare-build").click();
  await expect(page.locator("#files-status")).toContainText(
    "Staged GAME.NU, GAME.MAP",
  );
  await apply(page);
  await page.locator("#close-files").click();
  await runCommand(page, "NUC GAME.NU");
  await command(page, "GAME");
  await expect(page.locator("#terminal")).toContainText("CAVE>");
  await page.keyboard.type("E");
  await expect(page.locator("#terminal")).toContainText("HILL>");
  await page.keyboard.type("T");
  await expect(page.locator("#terminal")).toContainText("You have the key");
  await page.keyboard.type("W");
  await expect(page.locator("#terminal")).toContainText("You win!");
  await command(page, "EDIT MAIN.NU");
  await expect(page.locator("#terminal")).toContainText(
    "EDIT MAIN    .NU       ^S Save  ^Q Quit",
  );
  await page.keyboard.press("Control+f");
  await page.keyboard.type("CAVE");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+r");
  await page.keyboard.type("BASE");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("BASE>");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+q");
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent()).trimEnd().endsWith("A>"),
    )
    .toBe(true);
  await manage(page);
  await page.locator("#prepare-build").click();
  await expect(page.locator("#files-status")).toContainText("Staged GAME.NU");
  await apply(page);
  await page.locator("#close-files").click();
  await runCommand(page, "NUC GAME.NU");
  await command(page, "GAME");
  await expect(page.locator("#terminal")).toContainText("BASE>");
  await page.keyboard.type("Q");
  await expect(page.locator("#terminal")).toContainText("Bye.");
  await manage(page);
  const beforeUpdate = Buffer.from(await savedBytes(page));
  await page
    .locator("#tool-list li")
    .filter({ hasText: "NUC.COM" })
    .getByRole("button")
    .click();
  await expect(page.locator("#files-status")).toContainText("Staged NUC.COM");
  await apply(page);
  const afterUpdate = Buffer.from(await savedBytes(page));
  for (const name of [
    "IO.NU",
    "MAIN.NU",
    "BUILD.JSN",
    "GAME.NU",
    "GAME.MAP",
    "GAME.COM",
    "ATOM.COM",
    "EDIT.COM",
  ])
    expect(readCpm22File(afterUpdate, name)).toEqual(
      readCpm22File(beforeUpdate, name),
    );
  await page.locator("#close-files").click();
  await expect(page.locator("#save-status")).toHaveText(
    "Working disk saved in this browser.",
  );
  const saved = await savedBytes(page);
  await page.reload();
  await expect(page.locator("#terminal")).toContainText("A>");
  expect(await savedBytes(page)).toEqual(saved);
  await command(page, "GAME");
  await expect(page.locator("#terminal")).toContainText("BASE>");
  await page.keyboard.type("Q");
  await expect(page.locator("#terminal")).toContainText("Bye.");
  const pending = page.waitForEvent("download");
  await page.locator("#download").click();
  const downloaded = await pending;
  const path = info.outputPath("adventure.img");
  await downloaded.saveAs(path);
  expect(await readFile(path)).toEqual(Buffer.from(saved));
  const other = await browser.newContext({
    baseURL: new URL(page.url()).origin,
  });
  try {
    const reopened = await other.newPage();
    await boot(reopened);
    await manage(reopened);
    await reopened.locator("#disk-input").setInputFiles(path);
    await expect(reopened.locator("#commit-disk")).toBeEnabled();
    await apply(reopened);
    await reopened.locator("#close-files").click();
    expect(await savedBytes(reopened)).toEqual(saved);
    await command(reopened, "GAME");
    await expect(reopened.locator("#terminal")).toContainText("BASE>");
  } finally {
    await other.close();
  }
  const native = await nativeReopen(path);
  expect(native).toContain("BASE>");
  expect(native).toContain("Bye.");
  expect(await readFile(path)).toEqual(Buffer.from(saved));
});

test("a diagnostic mapping cannot replace status after its Files session closes", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (...args) => {
      if (globalThis.holdMapping) {
        globalThis.holdMapping = false;
        await new Promise((resolve) => {
          globalThis.resumeMapping = resolve;
        });
      }
      return digest(...args);
    };
  });
  await boot(page);
  await manage(page);
  await page.locator("#stage-adventure").click();
  await expect(page.locator("#files-status")).toContainText("Staged IO.NU");
  await page.locator("#prepare-build").click();
  await expect(page.locator("#files-status")).toContainText("Staged GAME.NU");
  await apply(page);
  await page
    .locator("#nucleus-diagnostic")
    .fill("Nucleus error 86 P=01 O=0000 L=0001 C=0001");
  await page.evaluate(() => {
    globalThis.holdMapping = true;
  });
  await page.locator("#locate-diagnostic").click();
  await expect
    .poll(() => page.evaluate(() => typeof globalThis.resumeMapping))
    .toBe("function");
  await page.locator("#close-files").click();
  const status = await page.locator("#files-status").textContent();
  await page.evaluate(async () => {
    globalThis.resumeMapping();
    // A later digest on the same WebCrypto queue settles after the held call.
    await crypto.subtle.digest("SHA-256", new Uint8Array(1));
  });
  await expect(page.locator("#files-status")).toHaveText(status);
  await page.locator("#files").click();
  await expect(page.locator("#files-status")).not.toContainText("→");
});

test("a failed project compile maps to its maintained source and preserves the runnable program", async ({
  page,
}) => {
  page.on("dialog", (dialog) => dialog.accept());
  await boot(page);
  await manage(page);
  await page.locator("#stage-adventure").click();
  await expect(page.locator("#files-status")).toContainText("Staged IO.NU");
  await page.locator("#prepare-build").click();
  await expect(page.locator("#files-status")).toContainText("Staged GAME.NU");
  await apply(page);
  await page.locator("#close-files").click();
  await runCommand(page, "NUC GAME.NU");
  await expect(page.locator("#save-status")).toHaveText(
    "Working disk saved in this browser.",
  );
  const previous = readCpm22File(
    Buffer.from(await savedBytes(page)),
    "GAME.COM",
  );
  await command(page, "EDIT MAIN.NU");
  await expect(page.locator("#terminal")).toContainText(
    "EDIT MAIN    .NU       ^S Save  ^Q Quit",
  );
  await page.keyboard.press("Control+f");
  await page.keyboard.type("sub main()");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Control+r");
  await page.keyboard.type("sub main(,)");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("sub main(,) fails");
  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+q");
  await expect
    .poll(async () =>
      (await page.locator("#terminal").textContent()).trimEnd().endsWith("A>"),
    )
    .toBe(true);
  await manage(page);
  await page.locator("#prepare-build").click();
  await expect(page.locator("#files-status")).toContainText("Staged GAME.NU");
  await apply(page);
  await page.locator("#close-files").click();
  await runCommand(page, "NUC GAME.NU");
  const text = await page.locator("#terminal").textContent();
  const diagnostic = text.match(
    /Nucleus error 86 P=01 O=[0-9A-F]{4} L=[0-9A-F]{4} C=[0-9A-F]{4}/,
  )?.[0];
  expect(diagnostic).toBeTruthy();
  const currentDisk = Buffer.from(await savedBytes(page));
  expect(readCpm22File(currentDisk, "GAME.COM")).toEqual(previous);
  for (const name of ["GAME.$$$", "GAME.BAK"])
    expect(() => readCpm22File(currentDisk, name)).toThrow();
  await page.locator("#files").click();
  await page.locator("#nucleus-diagnostic").fill(diagnostic);
  await page.locator("#locate-diagnostic").click();
  await expect(page.locator("#files-status")).toContainText(
    "→ MAIN.NU, line 3, column 10",
  );
  await page.locator("#close-files").click();
  await command(page, "GAME");
  await expect(page.locator("#terminal")).toContainText("CAVE>");
  await page.keyboard.type("Q");
  await expect(page.locator("#terminal")).toContainText("Bye.");
});
