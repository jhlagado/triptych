import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  inputTypeToBytes,
  keyEventToBytes,
  textInputToBytes,
  TERMINAL_ATTRIBUTE_BOLD,
  TERMINAL_ATTRIBUTE_REVERSE,
  TERMINAL_ATTRIBUTE_UNDERLINE,
  TERMINAL_COLUMNS,
  TERMINAL_ROWS,
  TerminalBuffer,
} from "../crates/triptych-host-wasm/web/terminal.js";

function writeText(terminal, text) {
  terminal.write(Uint8Array.from(Buffer.from(text, "latin1")));
}

function rowText(snapshot, row) {
  const start = row * snapshot.columns;
  return String.fromCharCode(
    ...snapshot.cells.slice(start, start + snapshot.columns),
  );
}

function cellIndex(row, column) {
  return row * TERMINAL_COLUMNS + column;
}

const webDirectory = resolve(
  import.meta.dirname,
  "..",
  "crates",
  "triptych-host-wasm",
  "web",
);
const [applicationSource, indexSource, styleSource] = await Promise.all([
  readFile(resolve(webDirectory, "app.js"), "utf8"),
  readFile(resolve(webDirectory, "index.html"), "utf8"),
  readFile(resolve(webDirectory, "style.css"), "utf8"),
]);
assert.ok(indexSource.includes("interactive-widget=resizes-content"));
assert.ok(
  applicationSource.includes("window.visualViewport?.addEventListener"),
);
assert.ok(
  applicationSource.includes("mobileInput.focus({ preventScroll: true })"),
);
assert.ok(styleSource.includes("body.terminal-keyboard-open main"));
assert.ok(
  styleSource.includes("grid-template-columns: repeat(4, minmax(0, 1fr))"),
);

{
  const terminal = new TerminalBuffer();
  const snapshot = terminal.snapshot();
  assert.equal(snapshot.columns, 80);
  assert.equal(snapshot.rows, 24);
  assert.equal(snapshot.cells.length, TERMINAL_COLUMNS * TERMINAL_ROWS);
  assert.ok([...snapshot.cells].every((value) => value === 0x20));
  assert.ok([...snapshot.attributes].every((value) => value === 0));
  assert.deepEqual([snapshot.cursorRow, snapshot.cursorColumn], [0, 0]);
}

{
  const terminal = new TerminalBuffer();
  writeText(terminal, "AB\nC\rD");
  const snapshot = terminal.snapshot();
  assert.equal(rowText(snapshot, 0).slice(0, 2), "AB");
  assert.equal(rowText(snapshot, 1).slice(0, 3), "D C");
  assert.deepEqual([snapshot.cursorRow, snapshot.cursorColumn], [1, 1]);
}

{
  const terminal = new TerminalBuffer();
  writeText(terminal, "X".repeat(TERMINAL_COLUMNS));
  let snapshot = terminal.snapshot();
  assert.deepEqual(
    [snapshot.cursorRow, snapshot.cursorColumn, snapshot.wrapPending],
    [0, 79, true],
  );
  writeText(terminal, "Y");
  snapshot = terminal.snapshot();
  assert.equal(rowText(snapshot, 1).at(0), "Y");
  assert.deepEqual(
    [snapshot.cursorRow, snapshot.cursorColumn, snapshot.wrapPending],
    [1, 1, false],
  );
}

{
  const terminal = new TerminalBuffer();
  for (let row = 0; row < TERMINAL_ROWS; row += 1) {
    writeText(terminal, String.fromCharCode(0x41 + row));
    if (row !== TERMINAL_ROWS - 1) writeText(terminal, "\r\n");
  }
  writeText(terminal, "\r\n");
  const snapshot = terminal.snapshot();
  assert.equal(rowText(snapshot, 0).at(0), "B");
  assert.equal(rowText(snapshot, 22).at(0), "X");
  assert.equal(rowText(snapshot, 23), " ".repeat(80));
}

{
  const terminal = new TerminalBuffer();
  writeText(terminal, "A\tB\bC\x07");
  const snapshot = terminal.snapshot();
  assert.equal(rowText(snapshot, 0).slice(0, 10), "A       C ");
  assert.equal(snapshot.cursorColumn, 9);
  assert.equal(snapshot.bellCount, 1);
}

{
  const terminal = new TerminalBuffer();
  terminal.write(Uint8Array.from([0x1b, 0x5b, 0x32, 0x34]));
  terminal.write(Uint8Array.from([0x3b, 0x38, 0x30, 0x48]));
  writeText(terminal, "Z\x1b[2A\x1b[3D!");
  const snapshot = terminal.snapshot();
  assert.equal(snapshot.cells[cellIndex(23, 79)], "Z".charCodeAt(0));
  assert.equal(snapshot.cells[cellIndex(21, 76)], "!".charCodeAt(0));
  assert.deepEqual([snapshot.cursorRow, snapshot.cursorColumn], [21, 77]);
}

{
  const terminal = new TerminalBuffer();
  writeText(terminal, "\x1b[7mABCDE\x1b[3D\x1b[0K");
  let snapshot = terminal.snapshot();
  assert.equal(rowText(snapshot, 0).slice(0, 5), "AB   ");
  assert.equal(snapshot.attributes[cellIndex(0, 2)], 0);
  writeText(terminal, "\x1b[1K");
  snapshot = terminal.snapshot();
  assert.equal(rowText(snapshot, 0).slice(0, 5), "     ");
  writeText(terminal, "XYZ\x1b[2K");
  assert.equal(rowText(terminal.snapshot(), 0), " ".repeat(80));
}

{
  const terminal = new TerminalBuffer();
  writeText(terminal, "\x1b[1;4;7mX\x1b[0mY");
  const snapshot = terminal.snapshot();
  assert.equal(
    snapshot.attributes[0],
    TERMINAL_ATTRIBUTE_BOLD |
      TERMINAL_ATTRIBUTE_UNDERLINE |
      TERMINAL_ATTRIBUTE_REVERSE,
  );
  assert.equal(snapshot.attributes[1], 0);
  assert.equal(snapshot.currentAttributes, 0);
}

{
  const terminal = new TerminalBuffer();
  const statusText = "EDIT INPUT.NU  ^S Save  ^Q Quit";
  writeText(terminal, "old text\x1b[2J\x1b[H");
  for (let row = 0; row < 23; row += 1) {
    writeText(terminal, row === 0 ? "sub main() fails" : "");
    writeText(terminal, "\r\n");
  }
  writeText(terminal, `\x1b[24;1H\x1b[7m${statusText}\x1b[0m\x1b[1;5H`);
  const snapshot = terminal.snapshot();
  assert.equal(rowText(snapshot, 0).slice(0, 16), "sub main() fails");
  assert.ok(rowText(snapshot, 23).startsWith(statusText));
  assert.ok(
    [
      ...snapshot.attributes.slice(
        cellIndex(23, 0),
        cellIndex(23, statusText.length),
      ),
    ].every((value) => value === TERMINAL_ATTRIBUTE_REVERSE),
  );
  assert.deepEqual([snapshot.cursorRow, snapshot.cursorColumn], [0, 4]);
  assert.ok(!terminal.text().includes("[24;1H"));
  assert.ok(!terminal.text().includes("[7m"));
}

{
  const terminal = new TerminalBuffer();
  writeText(terminal, "A\x1b7B\x1b[");
  writeText(terminal, "1".repeat(33));
  writeText(terminal, "C");
  assert.equal(rowText(terminal.snapshot(), 0).slice(0, 3), "ABC");
}

const keyEvent = (key, overrides = {}) => ({
  metaKey: false,
  altKey: false,
  ctrlKey: false,
  key,
  ...overrides,
});

assert.deepEqual([...keyEventToBytes(keyEvent("Enter"))], [13]);
assert.deepEqual([...keyEventToBytes(keyEvent("c", { ctrlKey: true }))], [3]);
assert.deepEqual([...keyEventToBytes(keyEvent("ArrowUp"))], [27, 91, 65]);
assert.deepEqual([...keyEventToBytes(keyEvent("ArrowDown"))], [27, 91, 66]);
assert.deepEqual([...keyEventToBytes(keyEvent("ArrowRight"))], [27, 91, 67]);
assert.deepEqual([...keyEventToBytes(keyEvent("ArrowLeft"))], [27, 91, 68]);
assert.equal(keyEventToBytes(keyEvent("v", { metaKey: true })), undefined);
assert.deepEqual([...keyEventToBytes(keyEvent("é"))], [0xe9]);

assert.deepEqual([...textInputToBytes("hello")], [104, 101, 108, 108, 111]);
assert.deepEqual(
  [...textInputToBytes("one\ntwo\r\nthree\rfour")],
  [
    111, 110, 101, 13, 116, 119, 111, 13, 116, 104, 114, 101, 101, 13, 102, 111,
    117, 114,
  ],
);
assert.deepEqual([...textInputToBytes("é🙂")], [0xe9]);
assert.deepEqual([...textInputToBytes("q", { control: true })], [17]);
assert.deepEqual(
  [...textInputToBytes("Qmore", { control: true })],
  [17, 109, 111, 114, 101],
);
assert.deepEqual([...textInputToBytes("?", { control: true })], [0x3f]);
assert.deepEqual([...inputTypeToBytes("deleteContentBackward")], [8]);
assert.deepEqual([...inputTypeToBytes("deleteContentForward")], [0x7f]);
assert.deepEqual([...inputTypeToBytes("insertLineBreak")], [13]);
assert.deepEqual([...inputTypeToBytes("insertParagraph")], [13]);
assert.equal(inputTypeToBytes("insertText"), undefined);

console.log("WASM browser ANSI terminal checks passed");
