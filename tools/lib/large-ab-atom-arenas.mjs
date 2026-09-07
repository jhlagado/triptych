import assert from "node:assert/strict";

// Original source fixtures for the released native CP/M ATOM adapter. These
// exercise its target arenas, not the larger Node-hosted assembler profile.
const source = (text) => Buffer.from(text, "ascii");
const globals = (count) =>
  Array.from(
    { length: count },
    (_, index) => `G${String(index).padStart(4, "0")}:\n`,
  ).join("");
const symbols = (count, tail = "") =>
  source(`ORG $0100\nRET\n${globals(count)}${tail}`);
const pending = (count) =>
  source(`ORG $0100\nRET\n${"DW TARGET\n".repeat(count)}TARGET:\nDB 0\n`);

function patchedReferences(count) {
  const bytes = Buffer.alloc(2 + count * 2);
  bytes[0] = 0xc9;
  for (let index = 0; index < count; index++)
    bytes.writeUInt16LE(0x101 + count * 2, 1 + index * 2);
  return bytes;
}

function symbolCases() {
  return {
    fixtures: new Map([
      ["GMAX.ASM", symbols(1536)],
      ["GOVER.ASM", symbols(1537)],
      ["MMAX.ASM", symbols(1535, ".P:\nDW .P\n")],
      ["MOVER.ASM", symbols(1535, ".P:\n.Q:\nDW .P\n")],
      ["EVICT.ASM", symbols(1535, ".P:\nDW .P\nG1535:\nDW G1535\n")],
      ["PMAX.ASM", pending(585)],
      ["POVER.ASM", pending(586)],
    ]),
    cases: [
      { name: "GMAX.ASM", expected: Buffer.from([0xc9]) },
      { name: "GOVER.ASM", error: "Atom error 02 00 2A0E" },
      { name: "MMAX.ASM", expected: Buffer.from([0xc9, 1, 1]) },
      { name: "MOVER.ASM", error: "Atom error 02 00 2A0B" },
      { name: "EVICT.ASM", expected: Buffer.from([0xc9, 1, 1, 3, 1]) },
      { name: "PMAX.ASM", expected: patchedReferences(585) },
      { name: "POVER.ASM", error: "Atom error 02 00 16E8" },
    ],
    limits: [
      "1536 global records; 1535 globals plus one private; private eviction at the full symbol arena",
      "585 simultaneous pending references to one forward label; 586 rejected; every patched word checked",
      "Expression value/operator-stack capacities and other reference forms are not qualified by this suite",
    ],
  };
}

function partCases() {
  const names = Array.from(
    { length: 255 },
    (_, index) => `P${String(index).padStart(3, "0")}.ASM`,
  );
  const fixtures = new Map(
    names.map((name, index) => [name, source(`DB ${index}\n`)]),
  );
  const root = (count) =>
    source(
      names
        .slice(0, count)
        .map((name) => `%INCLUDE "${name}"\n`)
        .join("") + "RET\n",
    );
  fixtures.set("WMAX.ASM", root(254));
  fixtures.set("WOVER.ASM", root(255));
  return {
    fixtures,
    cases: [
      {
        name: "WMAX.ASM",
        expected: Buffer.from([
          ...Array.from({ length: 254 }, (_, index) => index),
          0xc9,
        ]),
      },
      { name: "WOVER.ASM", error: "Too many sources" },
    ],
    limits: [
      "255 total source parts (root plus 254 dependencies), exact sibling order; 256 total parts rejected",
      "This is the native CP/M resolver; Node-hosted dependency limits are a separate contract",
    ],
  };
}

function chainCases() {
  const names = Array.from(
    { length: 255 },
    (_, index) => `C${String(index).padStart(3, "0")}.ASM`,
  );
  const fixtures = new Map(
    names.map((name, index) => [
      name,
      source(
        (index < 254 ? `%INCLUDE "${names[index + 1]}"\n` : "") +
          `DB ${index}\n`,
      ),
    ]),
  );
  fixtures.set("CYCA.ASM", source('%INCLUDE "CYCB.ASM"\nRET\n'));
  fixtures.set("CYCB.ASM", source('%INCLUDE "CYCA.ASM"\nRET\n'));
  return {
    fixtures,
    cases: [
      {
        name: "C000.ASM",
        expected: Buffer.from(
          Array.from({ length: 255 }, (_, index) => 254 - index),
        ),
      },
      { name: "CYCA.ASM", error: "Include cycle" },
    ],
    limits: [
      "255-part dependency chain with exact dependency-first output; two-file cycle rejected before publication",
      "The maximum chain is intentionally slow; no constant-time resolver or unmeasured stack-bound claim",
    ],
  };
}

/** Fresh closures and independent images keep every suite below 512 entries.
 * The caller owns execution, lifetime/guard observation and source preservation.
 */
export function createSuite(kind, { workLetter = "B" } = {}) {
  assert.match(workLetter, /^[A-P]$/);
  const prompt = `\r\n${workLetter}>`;
  const factories = {
    "atom-symbols": symbolCases,
    "atom-parts": partCases,
    "atom-chain": chainCases,
  };
  assert(Object.hasOwn(factories, kind), `Unknown ATOM arena suite: ${kind}`);
  const { fixtures, cases, limits } = factories[kind]();
  fixtures.set("END.TXT", source("AB-LIMITS-END"));
  let previous;
  const steps = [
    { id: "boot", input: "", suffix: "\r\nA>" },
    { id: "select-work-drive", input: `${workLetter}:\r`, suffix: prompt },
    ...cases.map(({ name, expected, error }) => ({
      id: `${kind}-${name.slice(0, -4).toLowerCase()}`,
      input: `ATOM ${name} KEEP.COM\r`,
      suffix: prompt,
      tool: "ATOM.COM",
      required: error ?? "KEEP.COM written",
      // The maximum dependency chain measured about 645 million instructions
      // in a slice-counted preflight. Keep this allowance local to that case;
      // the full lifetime observer still inspects each executed instruction.
      ...(kind === "atom-chain" && name === "C000.ASM"
        ? { maxInstructions: 750_000_000, maxMs: 300_000 }
        : {}),
      check(disk) {
        const actual = Buffer.from(disk.read_file("KEEP.COM"));
        if (expected) {
          // Native ATOM pads its binary output records with zero, unlike the
          // text importer's 1A padding. Compare the complete file, not a prefix.
          const rounded = Buffer.alloc(Math.ceil(expected.length / 128) * 128);
          expected.copy(rounded);
          assert.deepEqual(actual, rounded, `${name}: complete output records`);
          previous = Buffer.from(actual);
        } else {
          assert(previous, `${name}: preceding successful output is required`);
          assert.deepEqual(
            actual,
            previous,
            `${name}: failed assembly preserves output`,
          );
        }
        for (const temporary of ["KEEP.$$$", "KEEP.BAK"])
          assert(
            !disk.file_names().includes(temporary),
            `${name}: ${temporary} remains`,
          );
      },
    })),
    {
      id: "following-command",
      input: "TYPE END.TXT\r",
      suffix: prompt,
      required: "AB-LIMITS-END",
    },
  ];
  return { fixtures, steps, outputStems: ["KEEP"], limits };
}
