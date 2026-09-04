import { expect, test } from "@playwright/test";

function terminalText(page) {
  return page.locator("#terminal").textContent();
}

async function waitForPrompt(page, command) {
  await expect
    .poll(async () => {
      const text = (await terminalText(page)) ?? "";
      const lines = text
        .split("\n")
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      return {
        command: command === undefined || text.includes(command),
        lastLine: lines.at(-1),
      };
    })
    .toEqual({ command: true, lastLine: "A>" });
}

async function boot(page) {
  await page.goto("/");
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await waitForPrompt(page);
}

async function sendCommand(page, command) {
  await page.locator("#terminal").focus();
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

async function runCommand(page, command) {
  await sendCommand(page, command);
  await waitForPrompt(page, `A>${command}`);
}

async function waitForSavedDisk(page) {
  await expect(page.locator("#save-status")).toHaveText(
    "Working disk saved in this browser.",
  );
}

test("Edit, NUC, run, reload and reopen use the persisted working disk", async ({
  page,
}) => {
  await boot(page);
  await sendCommand(page, "EDIT INPUT.NU");
  await expect(page.locator("#terminal")).toContainText(
    "EDIT INPUT   .NU       ^S Save  ^Q Quit",
  );

  await page.keyboard.press("Control+f");
  await page.keyboard.type("'O'");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toHaveAttribute(
    "data-cursor-row",
    "2",
  );
  await expect(page.locator("#terminal")).toHaveAttribute(
    "data-cursor-column",
    "21",
  );

  await page.keyboard.press("Control+r");
  await page.keyboard.type("'Y'");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText(
    "writeOutputByte('Y') else fail",
  );

  await page.keyboard.press("Control+s");
  await page.keyboard.press("Control+q");
  await waitForPrompt(page);
  await runCommand(page, "NUC INPUT.NU");
  await runCommand(page, "INPUT");
  await expect(page.locator("#terminal")).toContainText("YK");
  await waitForSavedDisk(page);

  await page.reload();
  await expect(page.locator("#status")).toContainText(
    "Running the restored working disk",
  );
  await waitForSavedDisk(page);
  await waitForPrompt(page);
  await runCommand(page, "TYPE INPUT.NU");
  await expect(page.locator("#terminal")).toContainText(
    "writeOutputByte('Y') else fail",
  );

  await sendCommand(page, "EDIT INPUT.NU");
  await expect(page.locator("#terminal")).toContainText(
    "writeOutputByte('Y') else fail",
  );
  await expect(page.locator("#terminal")).toContainText(
    "EDIT INPUT   .NU       ^S Save  ^Q Quit",
  );
  await page.keyboard.press("Control+q");
  await waitForPrompt(page);
  await runCommand(page, "INPUT");
  await expect(page.locator("#terminal")).toContainText("YK");
});

test("a downloaded working disk can be imported into a fresh browser session", async ({
  browser,
  page,
}, testInfo) => {
  await boot(page);
  await runCommand(page, "SAVE 1 RECOVER.COM");
  await waitForSavedDisk(page);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#download").click();
  const download = await downloadPromise;
  const diskPath = testInfo.outputPath("recovered-working-disk.img");
  await download.saveAs(diskPath);

  const cleanContext = await browser.newContext();
  try {
    const cleanPage = await cleanContext.newPage();
    await boot(cleanPage);
    await cleanPage.locator("#disk-input").setInputFiles(diskPath);
    await expect(cleanPage.locator("#status")).toContainText(
      "Running recovered-working-disk.img",
    );
    await waitForPrompt(cleanPage);
    await runCommand(cleanPage, "DIR");
    await expect(cleanPage.locator("#terminal")).toContainText("RECOVER  COM");
  } finally {
    await cleanContext.close();
  }
});

test("a failed IndexedDB transaction is reported and a later flush recovers", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...arguments_) {
      const request = originalPut.apply(this, arguments_);
      if (sessionStorage.getItem("triptych-failed-put") !== "yes") {
        sessionStorage.setItem("triptych-failed-put", "yes");
        queueMicrotask(() => this.transaction.abort());
      }
      return request;
    };
  });

  await boot(page);
  await expect(page.locator("#save-status")).toContainText(
    "Browser storage failed:",
  );
  await runCommand(page, "SAVE 1 RETRY.COM");
  await waitForSavedDisk(page);

  await page.reload();
  await expect(page.locator("#status")).toContainText(
    "Running the restored working disk",
  );
  await waitForSavedDisk(page);
  await waitForPrompt(page);
  await runCommand(page, "DIR");
  await expect(page.locator("#terminal")).toContainText("RETRY    COM");
});

test("terminal paste normalizes a browser newline to a CP/M command", async ({
  page,
}) => {
  await boot(page);
  await page.locator("#terminal").evaluate((terminal) => {
    const clipboard = new DataTransfer();
    clipboard.setData("text/plain", "DIR\n");
    terminal.dispatchEvent(
      new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: clipboard,
      }),
    );
  });
  await waitForPrompt(page, "A>DIR");
  await expect(page.locator("#terminal")).toContainText("EDIT    COM");
});

test("the terminal and mobile keys remain inside a reduced visual viewport", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await boot(page);
    await sendCommand(page, "EDIT INPUT.NU");
    await expect(page.locator("#terminal")).toContainText(
      "EDIT INPUT   .NU       ^S Save  ^Q Quit",
    );

    await page.locator("#show-keyboard").click();
    await expect(page.locator("body")).toHaveClass(/terminal-keyboard-open/u);
    await expect(page.locator("#mobile-terminal-input")).toBeFocused();
    await page.setViewportSize({ width: 390, height: 430 });
    await page.evaluate(() =>
      visualViewport?.dispatchEvent(new Event("resize")),
    );

    const portrait = await page.evaluate(() => {
      const terminal = document
        .querySelector("#terminal")
        .getBoundingClientRect();
      const controls = document
        .querySelector(".mobile-terminal-controls")
        .getBoundingClientRect();
      return {
        headerDisplay: getComputedStyle(document.querySelector("header"))
          .display,
        terminal,
        terminalClientHeight: document.querySelector("#terminal").clientHeight,
        terminalScrollHeight: document.querySelector("#terminal").scrollHeight,
        controls,
        viewport: { width: innerWidth, height: innerHeight },
      };
    });
    expect(portrait.headerDisplay).toBe("none");
    expect(portrait.terminal.top).toBeGreaterThanOrEqual(0);
    expect(portrait.terminal.bottom).toBeLessThanOrEqual(
      portrait.viewport.height + 1,
    );
    expect(portrait.controls.bottom).toBeLessThanOrEqual(
      portrait.viewport.height + 1,
    );
    expect(portrait.controls.width).toBeLessThanOrEqual(
      portrait.viewport.width,
    );
    expect(portrait.terminalScrollHeight).toBeLessThanOrEqual(
      portrait.terminalClientHeight + 1,
    );
    const statusRowIsVisible = await page
      .locator("#terminal")
      .evaluate((terminal) => {
        const status = [...terminal.querySelectorAll(".terminal-reverse")].find(
          (element) => element.textContent.includes("^S Save  ^Q Quit"),
        );
        if (status === undefined) return false;
        const terminalBounds = terminal.getBoundingClientRect();
        const statusBounds = status.getBoundingClientRect();
        return (
          statusBounds.top >= terminalBounds.top &&
          statusBounds.bottom <= terminalBounds.bottom
        );
      });
    expect(statusRowIsVisible).toBe(true);

    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() =>
      visualViewport?.dispatchEvent(new Event("resize")),
    );
    await expect
      .poll(() =>
        page.evaluate(() => {
          const terminal = document
            .querySelector("#terminal")
            .getBoundingClientRect();
          const controls = document
            .querySelector(".mobile-terminal-controls")
            .getBoundingClientRect();
          return Math.max(terminal.bottom, controls.bottom) <= innerHeight + 1;
        }),
      )
      .toBe(true);

    await page.locator('[data-terminal-key="ArrowDown"]').click();
    await expect(page.locator("#terminal")).toHaveAttribute(
      "data-cursor-row",
      "2",
    );
    await page.locator("#terminal-control-key").click();
    await expect(page.locator("#terminal-control-key")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.keyboard.type("q");
    await waitForPrompt(page);
  } finally {
    await context.close();
  }
});
