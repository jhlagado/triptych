import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  type BdosDirectCallSequenceFixture,
  bdosBiosConsoleOutput,
  runBdosDirectCallSequence,
  unexpectedDirectCallWrites,
} from "../support/bdos-direct-call.js";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const referenceDisk = readFileSync(
  resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img"),
);
const referenceBdos = referenceDisk.subarray(0x0800, 0x1600);
const replacementBdosSource = resolve(
  repositoryRoot,
  "roms",
  "cpu",
  "bdos",
  "bdos.asm",
);
const sequenceDirectory = resolve(
  repositoryRoot,
  "test",
  "bdos",
  "fixtures",
  "sequences",
);
const mutationFixture = JSON.parse(
  readFileSync(
    resolve(sequenceDirectory, "file-mutation-roundtrip.json"),
    "utf8",
  ),
) as BdosDirectCallSequenceFixture;
const readFixture = JSON.parse(
  readFileSync(resolve(sequenceDirectory, "file-read-roundtrip.json"), "utf8"),
) as BdosDirectCallSequenceFixture;

const FCB = 0x0200;
const DMA = 0x0800;
const STACK_POINTER = 0xd000;
const BAD_SECTOR = Uint8Array.from(
  Buffer.from("\r\nBdos Err On A: Bad Sector", "ascii"),
);
const evidence = [
  {
    kind: "published-interface" as const,
    source: "Digital Research CP/M Operating System Manual, July 1982",
    section: "5.2 file service; 6.9 WRITE nonzero error result",
  },
  {
    kind: "black-box-compatibility" as const,
    source:
      "Frozen Triptych transitional BDOS SHA-256 258fe1b659a979fa9adab000fd2ee27b165349179f6b5f5b8b5266ea3385ac22",
    section: "Injected directory-sector BIOS WRITE failure and retry",
  },
];

type DirectoryMutation = "make" | "close" | "rename" | "attributes" | "delete";

function nameBytes(stem: string, extension: string): number[] {
  return [
    ...Buffer.from(stem.padEnd(8, " ").slice(0, 8), "ascii"),
    ...Buffer.from(extension.padEnd(3, " ").slice(0, 3), "ascii"),
  ];
}

function fcb(name: number[], renamedTo?: number[]): number[] {
  const bytes = new Array<number>(36).fill(0);
  bytes.splice(1, 11, ...name);
  if (renamedTo !== undefined) bytes.splice(17, 11, ...renamedTo);
  return bytes;
}

function directoryFailureSequence(operation: DirectoryMutation): {
  fixture: BdosDirectCallSequenceFixture;
  failureIndex: number;
  retryIndex: number;
} {
  const steps: BdosDirectCallSequenceFixture["steps"] = [];
  const push = (
    id: string,
    fn: number,
    de = FCB,
    initialMemory: NonNullable<
      BdosDirectCallSequenceFixture["steps"][number]["initialMemory"]
    > = [],
    failWrite = false,
  ): void => {
    steps.push({
      id,
      evidence,
      call: { function: fn, de, stackPointer: STACK_POINTER },
      initialMemory,
      biosResponses: failWrite
        ? [
            { entry: 14, occurrence: 0, return: { a: 1 } },
            { entry: 2, occurrence: "all", return: { a: 0 } },
            { entry: 3, occurrence: 0, return: { a: 13 } },
          ]
        : [],
      expected: {},
    });
  };

  const hello = nameBytes("HELLO", "TXT");
  const disk =
    operation === "make" ? mutationFixture.biosDisk : readFixture.biosDisk;
  if (disk === undefined) throw new Error("source fixture has no BIOS disk");

  push("reset", 13, 0);
  if (operation === "close") {
    push("set-dma", 26, DMA, [{ address: DMA, length: 128, fill: 0x5a }]);
    push("open", 15, FCB, [{ address: FCB, bytes: fcb(hello) }]);
    push("append", 21, FCB, [{ address: FCB + 32, bytes: [1] }]);
  }

  let fn: number;
  let initialMemory: NonNullable<
    BdosDirectCallSequenceFixture["steps"][number]["initialMemory"]
  > = [];
  if (operation === "make") {
    fn = 22;
    initialMemory = [
      { address: FCB, bytes: fcb(nameBytes("FAILMAKE", "DAT")) },
    ];
  } else if (operation === "close") {
    fn = 16;
  } else if (operation === "rename") {
    fn = 23;
    initialMemory = [
      {
        address: FCB,
        bytes: fcb(hello, nameBytes("RENAMED", "TXT")),
      },
    ];
  } else if (operation === "attributes") {
    fn = 30;
    const bytes = fcb(hello);
    bytes[11] = bytes[11]! | 0x80;
    initialMemory = [{ address: FCB, bytes }];
  } else {
    fn = 19;
    initialMemory = [{ address: FCB, bytes: fcb(hello) }];
  }

  const failureIndex = steps.length;
  push(`fail-${operation}`, fn, FCB, initialMemory, true);
  const retryIndex = steps.length;
  push(`retry-${operation}`, fn);
  return {
    fixture: {
      schema: "triptych-bdos-direct-sequence-v1",
      id: `directory-write-failure-${operation}`,
      description: `Reject and retry a directory-sector write during ${operation}`,
      biosDisk: JSON.parse(JSON.stringify(disk)),
      steps,
    },
    failureIndex,
    retryIndex,
  };
}

describe("CP/M 2.2 BDOS directory-write failure atomicity", () => {
  let replacementBdos: Uint8Array;
  let stackBase = 0;

  beforeAll(async () => {
    const assembled = await assembleZ80WithLabelsForTest(replacementBdosSource);
    replacementBdos = assembled.bytes;
    stackBase = assembled.labels.STKBASE!;
  });

  it.each<DirectoryMutation>([
    "make",
    "close",
    "rename",
    "attributes",
    "delete",
  ])(
    "does not publish a failed %s directory write and permits retry",
    (operation) => {
      const generated = directoryFailureSequence(operation);
      const oracle = runBdosDirectCallSequence(
        referenceBdos,
        generated.fixture,
      );
      const replacement = runBdosDirectCallSequence(
        replacementBdos,
        generated.fixture,
      );
      const beforeFailure =
        replacement.steps[generated.failureIndex - 1]!.result;
      const failed = replacement.steps[generated.failureIndex]!.result;
      const retried = replacement.steps[generated.retryIndex]!.result;
      const oracleFailure = oracle.steps[generated.failureIndex]!.result;

      expect(failed.biosDisk?.records).toEqual(beforeFailure.biosDisk?.records);
      expect(failed.biosDisk?.writes).toHaveLength(
        beforeFailure.biosDisk?.writes.length ?? 0,
      );
      expect([...bdosBiosConsoleOutput(failed.biosCalls)]).toEqual([
        ...BAD_SECTOR,
      ]);
      expect([...bdosBiosConsoleOutput(oracleFailure.biosCalls)]).toEqual([
        ...BAD_SECTOR,
      ]);
      expect(failed.registers.a).toBe(oracleFailure.registers.a);
      expect(failed.registers.l).toBe(oracleFailure.registers.l);
      expect(retried.biosDisk?.records).not.toEqual(
        beforeFailure.biosDisk?.records,
      );
      expect(retried.registers.a).not.toBe(0xff);
      expect(failed.minimumResidentStackPointer).toBeGreaterThanOrEqual(
        stackBase,
      );

      const allowedWrites = new Set<number>([
        ...Array.from({ length: 36 }, (_, offset) => FCB + offset),
        ...Array.from({ length: 128 }, (_, offset) => DMA + offset),
      ]);
      expect(
        unexpectedDirectCallWrites(
          failed,
          generated.fixture.steps[generated.failureIndex]!.call.stackPointer,
          allowedWrites,
        ),
      ).toEqual([]);
    },
  );
});
