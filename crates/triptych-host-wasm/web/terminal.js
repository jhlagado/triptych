export const TERMINAL_COLUMNS = 80;
export const TERMINAL_ROWS = 24;

export const TERMINAL_ATTRIBUTE_BOLD = 1 << 0;
export const TERMINAL_ATTRIBUTE_UNDERLINE = 1 << 1;
export const TERMINAL_ATTRIBUTE_REVERSE = 1 << 2;

const ASCII_BEL = 0x07;
const ASCII_BS = 0x08;
const ASCII_HT = 0x09;
const ASCII_LF = 0x0a;
const ASCII_CR = 0x0d;
const ASCII_ESC = 0x1b;
const ASCII_SPACE = 0x20;
const ASCII_TILDE = 0x7e;
const CSI_MAX_BYTES = 32;
const CELL_COUNT = TERMINAL_COLUMNS * TERMINAL_ROWS;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function parseCsiParameters(source) {
  if (source.length === 0) return [];
  return source.split(";").map((part) => {
    if (part.length === 0) return 0;
    const value = Number.parseInt(part, 10);
    return Number.isFinite(value) ? value : 0;
  });
}

function countParameter(parameters, index) {
  const value = parameters[index] ?? 0;
  return value <= 0 ? 1 : value;
}

export class TerminalBuffer {
  #cells = new Uint8Array(CELL_COUNT);
  #attributes = new Uint8Array(CELL_COUNT);
  #cursorRow = 0;
  #cursorColumn = 0;
  #currentAttributes = 0;
  #wrapPending = false;
  #bellCount = 0;
  #parserState = "ground";
  #csiParameters = "";
  #csiBytes = 0;

  constructor() {
    this.clear();
  }

  clear() {
    this.#cells.fill(ASCII_SPACE);
    this.#attributes.fill(0);
    this.#cursorRow = 0;
    this.#cursorColumn = 0;
    this.#currentAttributes = 0;
    this.#wrapPending = false;
    this.#bellCount = 0;
    this.#parserState = "ground";
    this.#csiParameters = "";
    this.#csiBytes = 0;
  }

  write(bytes) {
    for (const byte of bytes) this.#writeByte(byte & 0xff);
  }

  snapshot() {
    return {
      columns: TERMINAL_COLUMNS,
      rows: TERMINAL_ROWS,
      cells: this.#cells.slice(),
      attributes: this.#attributes.slice(),
      cursorRow: this.#cursorRow,
      cursorColumn: this.#cursorColumn,
      currentAttributes: this.#currentAttributes,
      wrapPending: this.#wrapPending,
      bellCount: this.#bellCount,
    };
  }

  text() {
    const rows = [];
    for (let row = 0; row < TERMINAL_ROWS; row += 1) {
      const start = row * TERMINAL_COLUMNS;
      rows.push(
        String.fromCharCode(
          ...this.#cells.slice(start, start + TERMINAL_COLUMNS),
        ).trimEnd(),
      );
    }
    while (rows.at(-1) === "") rows.pop();
    return rows.join("\n");
  }

  #cellIndex(row, column) {
    return row * TERMINAL_COLUMNS + column;
  }

  #clearCells(from, toInclusive) {
    if (toInclusive < from) return;
    this.#cells.fill(ASCII_SPACE, from, toInclusive + 1);
    this.#attributes.fill(0, from, toInclusive + 1);
  }

  #scrollUp() {
    this.#cells.copyWithin(0, TERMINAL_COLUMNS);
    this.#attributes.copyWithin(0, TERMINAL_COLUMNS);
    this.#clearCells(CELL_COUNT - TERMINAL_COLUMNS, CELL_COUNT - 1);
  }

  #lineFeed() {
    if (this.#cursorRow === TERMINAL_ROWS - 1) {
      this.#scrollUp();
    } else {
      this.#cursorRow += 1;
    }
  }

  #cancelWrap() {
    this.#wrapPending = false;
  }

  #writePrintable(byte) {
    if (this.#wrapPending) {
      this.#cursorColumn = 0;
      this.#lineFeed();
      this.#wrapPending = false;
    }
    const index = this.#cellIndex(this.#cursorRow, this.#cursorColumn);
    this.#cells[index] = byte;
    this.#attributes[index] = this.#currentAttributes;
    if (this.#cursorColumn === TERMINAL_COLUMNS - 1) {
      this.#wrapPending = true;
    } else {
      this.#cursorColumn += 1;
    }
  }

  #eraseDisplay(mode) {
    const cursor = this.#cellIndex(this.#cursorRow, this.#cursorColumn);
    if (mode === 0) this.#clearCells(cursor, CELL_COUNT - 1);
    if (mode === 1) this.#clearCells(0, cursor);
    if (mode === 2) this.#clearCells(0, CELL_COUNT - 1);
  }

  #eraseLine(mode) {
    const lineStart = this.#cellIndex(this.#cursorRow, 0);
    const cursor = lineStart + this.#cursorColumn;
    const lineEnd = lineStart + TERMINAL_COLUMNS - 1;
    if (mode === 0) this.#clearCells(cursor, lineEnd);
    if (mode === 1) this.#clearCells(lineStart, cursor);
    if (mode === 2) this.#clearCells(lineStart, lineEnd);
  }

  #selectGraphicRendition(parameters) {
    const values = parameters.length === 0 ? [0] : parameters;
    for (const value of values) {
      if (value === 0) this.#currentAttributes = 0;
      if (value === 1) this.#currentAttributes |= TERMINAL_ATTRIBUTE_BOLD;
      if (value === 4) this.#currentAttributes |= TERMINAL_ATTRIBUTE_UNDERLINE;
      if (value === 7) this.#currentAttributes |= TERMINAL_ATTRIBUTE_REVERSE;
    }
  }

  #executeCsi(finalByte) {
    const parameters = parseCsiParameters(this.#csiParameters);
    this.#cancelWrap();
    if (finalByte === 0x41) {
      this.#cursorRow = clamp(
        this.#cursorRow - countParameter(parameters, 0),
        0,
        TERMINAL_ROWS - 1,
      );
    } else if (finalByte === 0x42) {
      this.#cursorRow = clamp(
        this.#cursorRow + countParameter(parameters, 0),
        0,
        TERMINAL_ROWS - 1,
      );
    } else if (finalByte === 0x43) {
      this.#cursorColumn = clamp(
        this.#cursorColumn + countParameter(parameters, 0),
        0,
        TERMINAL_COLUMNS - 1,
      );
    } else if (finalByte === 0x44) {
      this.#cursorColumn = clamp(
        this.#cursorColumn - countParameter(parameters, 0),
        0,
        TERMINAL_COLUMNS - 1,
      );
    } else if (finalByte === 0x48 || finalByte === 0x66) {
      this.#cursorRow = clamp(
        countParameter(parameters, 0) - 1,
        0,
        TERMINAL_ROWS - 1,
      );
      this.#cursorColumn = clamp(
        countParameter(parameters, 1) - 1,
        0,
        TERMINAL_COLUMNS - 1,
      );
    } else if (finalByte === 0x4a) {
      this.#eraseDisplay(parameters[0] ?? 0);
    } else if (finalByte === 0x4b) {
      this.#eraseLine(parameters[0] ?? 0);
    } else if (finalByte === 0x6d) {
      this.#selectGraphicRendition(parameters);
    }
  }

  #writeGroundByte(byte) {
    if (byte >= ASCII_SPACE && byte <= ASCII_TILDE) {
      this.#writePrintable(byte);
    } else if (byte === ASCII_ESC) {
      this.#parserState = "escape";
    } else if (byte === ASCII_BEL) {
      this.#bellCount += 1;
    } else if (byte === ASCII_BS) {
      this.#cancelWrap();
      this.#cursorColumn = Math.max(0, this.#cursorColumn - 1);
    } else if (byte === ASCII_HT) {
      this.#cancelWrap();
      this.#cursorColumn = Math.min(
        TERMINAL_COLUMNS - 1,
        (Math.floor(this.#cursorColumn / 8) + 1) * 8,
      );
    } else if (byte === ASCII_LF) {
      this.#cancelWrap();
      this.#lineFeed();
    } else if (byte === ASCII_CR) {
      this.#cancelWrap();
      this.#cursorColumn = 0;
    }
  }

  #writeByte(byte) {
    if (this.#parserState === "ground") {
      this.#writeGroundByte(byte);
      return;
    }
    if (this.#parserState === "escape") {
      if (byte === 0x5b) {
        this.#parserState = "csi";
        this.#csiParameters = "";
        this.#csiBytes = 0;
      } else {
        this.#parserState = "ground";
      }
      return;
    }

    this.#csiBytes += 1;
    if (this.#csiBytes > CSI_MAX_BYTES) {
      this.#parserState = "ground";
      this.#csiParameters = "";
      return;
    }
    if ((byte >= 0x30 && byte <= 0x39) || byte === 0x3b) {
      this.#csiParameters += String.fromCharCode(byte);
      return;
    }
    if (byte >= 0x40 && byte <= 0x7e) this.#executeCsi(byte);
    this.#parserState = "ground";
    this.#csiParameters = "";
  }
}

function cellClasses(attributes, cursor) {
  const classes = [];
  if ((attributes & TERMINAL_ATTRIBUTE_BOLD) !== 0)
    classes.push("terminal-bold");
  if ((attributes & TERMINAL_ATTRIBUTE_UNDERLINE) !== 0)
    classes.push("terminal-underline");
  if ((attributes & TERMINAL_ATTRIBUTE_REVERSE) !== 0)
    classes.push("terminal-reverse");
  if (cursor) classes.push("terminal-cursor");
  return classes.join(" ");
}

export function renderTerminal(element, snapshot) {
  const document = element.ownerDocument;
  const fragment = document.createDocumentFragment();
  for (let row = 0; row < snapshot.rows; row += 1) {
    let column = 0;
    while (column < snapshot.columns) {
      const index = row * snapshot.columns + column;
      const attributes = snapshot.attributes[index];
      const cursor =
        row === snapshot.cursorRow && column === snapshot.cursorColumn;
      let end = column + 1;
      while (end < snapshot.columns) {
        const nextIndex = row * snapshot.columns + end;
        const nextCursor =
          row === snapshot.cursorRow && end === snapshot.cursorColumn;
        if (
          snapshot.attributes[nextIndex] !== attributes ||
          nextCursor !== cursor
        ) {
          break;
        }
        end += 1;
      }
      const span = document.createElement("span");
      span.className = cellClasses(attributes, cursor);
      span.textContent = String.fromCharCode(
        ...snapshot.cells.slice(index, index + end - column),
      );
      fragment.append(span);
      column = end;
    }
    if (row !== snapshot.rows - 1) fragment.append("\n");
  }
  element.replaceChildren(fragment);
  element.dataset.cursorRow = String(snapshot.cursorRow + 1);
  element.dataset.cursorColumn = String(snapshot.cursorColumn + 1);
  element.dataset.bellCount = String(snapshot.bellCount);
}

const NAMED_KEY_BYTES = new Map([
  ["Enter", [ASCII_CR]],
  ["Backspace", [ASCII_BS]],
  ["Delete", [0x7f]],
  ["Escape", [ASCII_ESC]],
  ["Tab", [ASCII_HT]],
  ["ArrowUp", [ASCII_ESC, 0x5b, 0x41]],
  ["ArrowDown", [ASCII_ESC, 0x5b, 0x42]],
  ["ArrowRight", [ASCII_ESC, 0x5b, 0x43]],
  ["ArrowLeft", [ASCII_ESC, 0x5b, 0x44]],
]);

export function keyEventToBytes(event) {
  if (event.metaKey || event.altKey) return undefined;
  if (event.ctrlKey && event.key.length === 1) {
    const code = event.key.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? Uint8Array.of(code & 0x1f) : undefined;
  }
  const named = NAMED_KEY_BYTES.get(event.key);
  if (named !== undefined) return Uint8Array.from(named);
  if (event.key.length !== 1) return undefined;
  const code = event.key.charCodeAt(0);
  return code <= 255 ? Uint8Array.of(code) : undefined;
}
