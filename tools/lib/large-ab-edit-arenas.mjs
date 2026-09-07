import assert from "node:assert/strict";

// EDIT 0.2.0: 5513-byte native ATOM artifact, SHA-256
// 6be83f6edb9ee92387c7b3817f473fbbc389a58ab1a20d9a2a6101e695fb77c4.
// Addresses are verified against that artifact's descriptive D8 symbol ledger.
// Logical text consists of the occupied prefix and suffix around the gap.
const TEXT = 0x2000;
const CAPACITY = 0xb800;
const GAP_START = 0x1f4a;
const GAP_END = 0x1f4c;
const LENGTH = 0x1ec8;
const QUERY_LENGTH = 0x1ed4;
const DMA = 0x1e48;
const SAVE_STATE = 0x1f15;
const HORIZONTAL_HIGH = 0x1f24;
const cursor = "\x1b[1;1H";
const pad = (bytes) => {
  const records = Buffer.alloc(Math.ceil(bytes.length / 128) * 128, 0x1a);
  bytes.copy(records);
  return records;
};
const ram = (cpu, address, length) =>
  Buffer.from(cpu.read_ram(address, length));

function logicalText(cpu) {
  const length = ram(cpu, LENGTH, 2).readUInt16LE();
  const start = ram(cpu, GAP_START, 2).readUInt16LE();
  const end = ram(cpu, GAP_END, 2).readUInt16LE();
  assert(start <= end && end <= CAPACITY, "valid arena-relative gap bounds");
  assert.equal(
    length,
    CAPACITY - (end - start),
    "length agrees with occupied gap spans",
  );
  return Buffer.concat([
    ram(cpu, TEXT, start),
    ram(cpu, TEXT + end, CAPACITY - end),
  ]);
}

export function createSuite(_kind, { workLetter = "B" } = {}) {
  assert.match(workLetter, /^[A-P]$/);
  const prompt = `\r\n${workLetter}>`;
  const originalQuery = Buffer.from("Q".repeat(64) + "TAIL");
  const replacedQuery = Buffer.from("R".repeat(64) + "TAIL");
  const originalGrow = Buffer.from("Q" + "A".repeat(47102));
  const fullGrow = Buffer.from("QQ" + "A".repeat(47102));
  const fixtures = new Map([
    ["QUERY.TXT", Buffer.from(originalQuery)],
    ["GROW.TXT", Buffer.from(originalGrow)],
    ["END.TXT", Buffer.from("AB-LIMITS-END")],
  ]);
  const steps = [];
  let queryRecords = pad(originalQuery);
  let growRecords = pad(originalGrow);
  let liveText;
  let committedQuery;
  let growthState;

  const add = (id, input, required, options = {}) => {
    const {
      suffix = cursor,
      open = true,
      bells = 0,
      onlyBell = false,
      memory,
      ...rest
    } = options;
    const expectedQuery = queryRecords;
    const expectedGrow = growRecords;
    const expectedText = open ? liveText : undefined;
    const expectedLiteral = open ? committedQuery : undefined;
    steps.push({
      id: `edit-${id}`,
      input,
      suffix,
      required,
      ...(open ? { open: true } : {}),
      ...rest,
      check(disk) {
        assert.deepEqual(
          Buffer.from(disk.read_file("QUERY.TXT")),
          expectedQuery,
          `${id}: complete QUERY records, including unchanged bytes until Save`,
        );
        assert.deepEqual(
          Buffer.from(disk.read_file("GROW.TXT")),
          expectedGrow,
          `${id}: complete GROW records, including unchanged bytes until Save`,
        );
      },
      checkOutput(fresh) {
        const bytes = Buffer.from(fresh);
        assert.equal(
          bytes.filter((byte) => byte === 7).length,
          bells,
          `${id}: exact bell count`,
        );
        if (onlyBell)
          assert.deepEqual(
            bytes,
            Buffer.of(7),
            `${id}: rejected byte only rings`,
          );
        assert(
          bytes.toString("latin1").endsWith(suffix),
          `${id}: cursor/prompt boundary`,
        );
        assert(
          bytes.includes(Buffer.from(required, "latin1")),
          `${id}: fresh output`,
        );
      },
      checkMemory(cpu) {
        if (expectedText) {
          assert.deepEqual(
            logicalText(cpu),
            expectedText,
            `${id}: logical text`,
          );
          assert.equal(
            ram(cpu, LENGTH, 2).readUInt16LE(),
            expectedText.length,
            `${id}: text length`,
          );
        }
        if (expectedLiteral !== undefined) {
          const literal = Buffer.from(expectedLiteral);
          assert.equal(
            ram(cpu, QUERY_LENGTH, 1)[0],
            literal.length,
            `${id}: query length`,
          );
          assert.deepEqual(
            ram(cpu, QUERY_LENGTH + 1, literal.length),
            literal,
            `${id}: retained query`,
          );
        }
        memory?.(cpu);
      },
    });
  };
  const launch = (id, name, text) => {
    liveText = text;
    committedQuery = "";
    const stem = name.split(".")[0].padEnd(8);
    add(id, `EDIT ${name}\r`, `EDIT ${stem}.TXT`, { tool: "EDIT.COM" });
  };
  const quit = (id) => add(id, "\x11", prompt, { suffix: prompt, open: false });

  add("boot", "", "\r\nA>", { suffix: "\r\nA>", open: false });
  add("select-work-drive", `${workLetter}:\r`, prompt, {
    suffix: prompt,
    open: false,
  });
  launch("query-open", "QUERY.TXT", originalQuery);
  committedQuery = "Q".repeat(64);
  add("query-64", "\x06" + committedQuery, "Find: " + committedQuery, {
    suffix: "\x1b[24;71H",
  });
  add("query-65", "Z", "\x07", { suffix: "\x07", bells: 1, onlyBell: true });
  add("query-accept", "\r", "Found");
  const replacementDma = (cpu) => {
    assert.equal(ram(cpu, DMA, 1)[0], 64);
    assert.deepEqual(ram(cpu, DMA + 1, 64), Buffer.from("R".repeat(64)));
  };
  add("replacement-64", "\x12" + "R".repeat(64), "Replace: " + "R".repeat(64), {
    suffix: "\x1b[24;74H",
    memory: replacementDma,
  });
  add("replacement-65", "Y", "\x07", {
    suffix: "\x07",
    bells: 1,
    onlyBell: true,
    memory: replacementDma,
  });
  liveText = replacedQuery;
  add("replacement-accept", "\r", "Replaced");
  queryRecords = pad(replacedQuery);
  add("replacement-save", "\x13", "Saved");
  committedQuery = "R".repeat(64);
  add("query-new", "\x06" + "\x08".repeat(64) + committedQuery + "\r", "Found");
  add("query-cancel", "\x06\x08X\x1b", "EDIT QUERY   .TXT");
  add("replacement-cancel", "\x12CANCELLED\x1b", "EDIT QUERY   .TXT");
  add("cancel-save", "\x13", "Saved");
  add("query-survives-save", "\x0e", "Wrapped");
  quit("query-quit");
  launch("query-reopen", "QUERY.TXT", replacedQuery);
  quit("query-reopen-quit");
  launch("grow-open", "GROW.TXT", originalGrow);
  committedQuery = "Q";
  add("grow-query", "\x06Q\r", "Found");
  liveText = fullGrow;
  const persistentGrowthState = (cpu) =>
    Buffer.concat([
      // Length, cursor, viewport, desired column and flags. Exclude status,
      // renderer/scratch temporaries and the disposable replacement DMA span.
      ram(cpu, LENGTH, 11),
      ram(cpu, QUERY_LENGTH, 65),
      ram(cpu, SAVE_STATE, 1),
      // High bytes of the persistent horizontal/desired visual columns.
      ram(cpu, HORIZONTAL_HIGH, 2),
      // Rejection must preserve physical storage too, including unused gap bytes.
      ram(cpu, GAP_START, 4),
      ram(cpu, TEXT, CAPACITY),
    ]);
  add("grow-exact", "\x12QQ\r", "Replaced", {
    memory(cpu) {
      growthState = persistentGrowthState(cpu);
    },
  });
  add("grow-over", "\x12QQ\r", "Full", {
    bells: 1,
    memory(cpu) {
      assert(growthState, "Accepted growth boundary must be observed first");
      assert.deepEqual(
        persistentGrowthState(cpu),
        growthState,
        "Rejected growth preserves persistent editor state",
      );
    },
  });
  growRecords = pad(fullGrow);
  add("grow-save", "\x13", "Saved");
  quit("grow-quit");
  launch("grow-reopen", "GROW.TXT", fullGrow);
  add("grow-reopen-save", "\x13", "Saved");
  quit("grow-reopen-quit");
  add("end", "TYPE END.TXT\r", "AB-LIMITS-END" + prompt, {
    suffix: prompt,
    open: false,
  });

  return {
    fixtures,
    steps,
    mutableFiles: new Set(["QUERY.TXT", "GROW.TXT"]),
    outputStems: ["QUERY", "GROW"],
    limits: [
      { boundary: "Edit query", accepted: 64, rejected: 65, units: "bytes" },
      {
        boundary: "Edit replacement",
        accepted: 64,
        rejected: 65,
        units: "bytes",
      },
      {
        boundary: "Edit replacement result",
        accepted: 47104,
        rejected: 47105,
        units: "logical bytes",
        failure: "Full; text and persistent editor state unchanged",
      },
      {
        boundary: "Edit inactive DMA overlay",
        proof:
          "query and replacement cancellation, Save, retained-query repeat and exact saved-file reopen",
      },
    ],
  };
}
