import {
  expect,
  test,
  seedLegacyDisk,
  adoptHistoricalMachine,
} from "./legacy-fixture.mjs";
import { readFile } from "node:fs/promises";

const terminalSource = await readFile(
  new URL(
    "../../../crates/triptych-host-wasm/web/terminal.js",
    import.meta.url,
  ),
  "utf8",
);

async function cursorGeometry(page) {
  return page.locator("#terminal").evaluate((terminal) => {
    const cursor = terminal.querySelector(".terminal-cursor");
    const bounds = terminal.getBoundingClientRect();
    const cell = cursor.getBoundingClientRect();
    const left = bounds.left + terminal.clientLeft;
    const top = bounds.top + terminal.clientTop;
    return {
      visible:
        cell.left >= left - 1 &&
        cell.right <= left + terminal.clientWidth + 1 &&
        cell.top >= top - 1 &&
        cell.bottom <= top + terminal.clientHeight + 1,
      scrollLeft: terminal.scrollLeft,
      scrollTop: terminal.scrollTop,
      pageX: window.scrollX,
      pageY: window.scrollY,
      row: terminal.dataset.cursorRow,
      column: terminal.dataset.cursorColumn,
    };
  });
}

test("cursor reveal scrolls only the terminal and retains the 80 by 24 grid", async ({
  page,
}) => {
  await page.setContent(`
    <style>
      body { margin: 0; min-height: 1800px; }
      #terminal { margin: 160px 24px; width: 230px; height: 105px;
        padding: 11px; border: 3px solid; overflow: auto;
        font: 16px/1.35 monospace; white-space: pre; }
    </style>
    <pre id="terminal"></pre>
  `);
  await page.evaluate(async (source) => {
    globalThis.terminalModule = await import(
      `data:text/javascript,${encodeURIComponent(source)}`
    );
    window.scrollTo(0, 80);
  }, terminalSource);
  const initialPage = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  for (const [row, column] of [
    [24, 80],
    [1, 1],
    [13, 40],
  ]) {
    await page.evaluate(
      ({ row, column }) => {
        const { TerminalBuffer, renderTerminal, revealTerminalCursor } =
          globalThis.terminalModule;
        const terminal = document.querySelector("#terminal");
        const buffer = new TerminalBuffer();
        buffer.write(new TextEncoder().encode(`\x1b[${row};${column}H`));
        renderTerminal(terminal, buffer.snapshot());
        revealTerminalCursor(terminal);
      },
      { row, column },
    );
    expect(await cursorGeometry(page)).toMatchObject({
      visible: true,
      pageX: initialPage.x,
      pageY: initialPage.y,
      row: String(row),
      column: String(column),
    });
    expect(await page.locator("#terminal").textContent()).toHaveLength(
      24 * 80 + 23,
    );
    const before = await cursorGeometry(page);
    await page.evaluate(() =>
      globalThis.terminalModule.revealTerminalCursor(
        document.querySelector("#terminal"),
      ),
    );
    expect(await cursorGeometry(page)).toEqual(before);
  }
  await page.evaluate(() => {
    const terminal = document.querySelector("#terminal");
    terminal.replaceChildren();
    globalThis.terminalModule.revealTerminalCursor(terminal);
  });
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(
    initialPage,
  );
});

async function bootEditor(page) {
  await seedLegacyDisk(page);
  await adoptHistoricalMachine(page);
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );
  await expect(page.locator("#terminal")).toContainText("A>");
  await page.locator("#terminal").focus();
  await page.keyboard.type("EDIT INPUT.NU");
  await page.keyboard.press("Enter");
  await expect(page.locator("#terminal")).toContainText("^S Save  ^Q Quit");
}

// Chromium touch and reduced viewport simulations do not open a real Android
// or iOS software keyboard. Physical keyboard appearance/composition still
// require device qualification.
for (const entry of ["touch", "Keyboard"]) {
  test(`${entry} entry reveals moving cursor in portrait and landscape without scrolling the page`, async ({
    browser,
  }) => {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    try {
      const page = await context.newPage();
      await bootEditor(page);
      if (entry === "touch") await page.locator("#terminal").tap();
      else await page.locator("#show-keyboard").tap();
      await expect(page.locator("#mobile-terminal-input")).toBeFocused();
      await expect(page.locator("#show-keyboard")).toHaveText("Done");
      await page.setViewportSize({ width: 390, height: 400 });
      await page.keyboard.type("X".repeat(70));
      await expect(page.locator("#terminal")).toHaveAttribute(
        "data-cursor-column",
        "71",
      );
      await expect
        .poll(async () => (await cursorGeometry(page)).visible)
        .toBe(true);
      expect((await cursorGeometry(page)).scrollLeft).toBeGreaterThan(0);
      const pagePosition = await page.evaluate(() => ({
        x: scrollX,
        y: scrollY,
      }));

      for (let index = 0; index < 70; index += 1)
        await page.locator('[data-terminal-key="ArrowLeft"]').tap();
      await expect(page.locator("#terminal")).toHaveAttribute(
        "data-cursor-column",
        "1",
      );
      await expect
        .poll(async () => (await cursorGeometry(page)).visible)
        .toBe(true);
      expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(
        pagePosition,
      );

      await page.setViewportSize({ width: 740, height: 240 });
      const landscapePosition = await page.evaluate(() => ({
        x: scrollX,
        y: scrollY,
      }));
      for (let index = 0; index < 22; index += 1)
        await page.keyboard.press("Enter");
      await expect(page.locator("#terminal")).toHaveAttribute(
        "data-cursor-row",
        "23",
      );
      await expect
        .poll(async () => (await cursorGeometry(page)).visible)
        .toBe(true);
      expect((await cursorGeometry(page)).scrollTop).toBeGreaterThan(0);
      expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(
        landscapePosition,
      );
      expect(await page.locator("#terminal").textContent()).toHaveLength(
        24 * 80 + 23,
      );
      const layout = await page.evaluate(() => {
        const terminal = document
          .querySelector("#terminal")
          .getBoundingClientRect();
        const keys = document
          .querySelector(".mobile-terminal-controls")
          .getBoundingClientRect();
        return (
          terminal.top >= 0 &&
          terminal.bottom <= keys.top &&
          keys.bottom <= innerHeight + 1
        );
      });
      expect(layout).toBe(true);
      await page.locator("#show-keyboard").tap();
      await expect(page.locator("#show-keyboard")).toHaveText("Keyboard");
      await expect(page.locator("#mobile-terminal-input")).not.toBeFocused();
    } finally {
      await context.close();
    }
  });
}

test("Files clears the Ctrl latch, isolates keyboard input and closes without reopening the terminal keyboard", async ({
  browser,
}) => {
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  try {
    const page = await context.newPage();
    await bootEditor(page);
    await page.locator("#terminal-control-key").tap();
    await expect(page.locator("#terminal-control-key")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.locator("#show-keyboard").tap();
    await page.locator("#files").tap();
    await expect(page.locator("#files-dialog")).toBeVisible();
    await expect(page.locator("#terminal-control-key")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await expect(page.locator("body")).not.toHaveClass(
      /terminal-keyboard-open/u,
    );
    const before = await page.locator("#terminal").textContent();
    await page.locator("#saved-and-exited").focus();
    await page.keyboard.type("DIR");
    // Exercise both terminal event paths while their UI is inert under the
    // modal, so a future handler relocation cannot bypass the guest-input gate.
    await page.evaluate(() => {
      document
        .querySelector("#terminal")
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "X", bubbles: true }),
        );
      const input = document.querySelector("#mobile-terminal-input");
      input.value = "Y";
      input.dispatchEvent(
        new InputEvent("input", {
          data: "Y",
          inputType: "insertText",
          bubbles: true,
        }),
      );
    });
    await page.locator("#close-files").tap();
    await expect(page.locator("#files-dialog")).not.toBeVisible();
    await expect(page.locator("#show-keyboard")).toHaveText("Keyboard");
    await expect(page.locator("#mobile-terminal-input")).not.toBeFocused();
    await expect(page.locator("#terminal")).toHaveText(before);
    await page.locator("#terminal").focus();
    await page.keyboard.type("Z");
    await expect(page.locator("#terminal")).toHaveAttribute(
      "data-cursor-column",
      "2",
    );
    expect((await page.locator("#terminal").textContent()).split("\n")[0]).toBe(
      `Z${before.split("\n")[0]}`.slice(0, 80),
    );
  } finally {
    await context.close();
  }
});
