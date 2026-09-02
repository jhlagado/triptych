import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import {
  type BdosDirectCallSequenceFixture,
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
const mutationFixture = JSON.parse(
  readFileSync(
    resolve(
      repositoryRoot,
      "test",
      "bdos",
      "fixtures",
      "sequences",
      "file-mutation-roundtrip.json",
    ),
    "utf8",
  ),
) as BdosDirectCallSequenceFixture;

const FCB = 0x0200;
const DMA = 0x0800;
const ALLOCATION_VECTOR = 0xfd20;
const STACK_POINTER = 0xd000;
const evidence = [
  {
    kind: "published-interface" as const,
    source: "Digital Research CP/M Operating System Manual, July 1982",
    section: "5.2, FCB file services and sequential/random record fields",
  },
];

type ModelExpectation =
  | { kind: "none" }
  | { kind: "zero" }
  | { kind: "success" }
  | { kind: "absent" }
  | { kind: "read"; bytes: number[] }
  | { kind: "size"; records: number }
  | { kind: "random-record"; records: number };

interface GeneratedSequence {
  fixture: BdosDirectCallSequenceFixture;
  expectations: ModelExpectation[];
}

interface ModelFile {
  name: number[];
  records: number[][];
}

function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function encodedName(prefix: string, identity: number): number[] {
  const stem = `${prefix}${identity.toString(16).toUpperCase().padStart(7, "0")}`;
  return [...Buffer.from(`${stem}DAT`, "ascii")];
}

function fcbBytes(name: number[], renamedTo?: number[]): number[] {
  const bytes = new Array<number>(36).fill(0);
  bytes.splice(1, 11, ...name);
  if (renamedTo !== undefined) bytes.splice(17, 11, ...renamedTo);
  return bytes;
}

function recordBytes(seed: number, identity: number, record: number): number[] {
  const next = generator(seed ^ (identity * 0x9e3779b9) ^ record);
  return Array.from({ length: 128 }, (_, offset) =>
    offset < 8
      ? [seed, identity, record, offset][offset & 3]! & 0xff
      : next() & 0xff,
  );
}

function randomRecordBytes(records: number): number[] {
  return [records & 0xff, (records >>> 8) & 0xff, records >>> 16];
}

function generatedFilesystemSequence(seed: number): GeneratedSequence {
  if (mutationFixture.biosDisk === undefined) {
    throw new Error("mutation fixture has no BIOS disk");
  }
  const next = generator(seed);
  const files: ModelFile[] = [];
  const steps: BdosDirectCallSequenceFixture["steps"] = [];
  const expectations: ModelExpectation[] = [];
  let nextIdentity = 0;
  let stepIdentity = 0;

  const push = (
    label: string,
    fn: number,
    expectation: ModelExpectation,
    initialMemory: NonNullable<
      BdosDirectCallSequenceFixture["steps"][number]["initialMemory"]
    > = [],
    de = FCB,
  ): void => {
    steps.push({
      id: `${stepIdentity.toString().padStart(3, "0")}-${label}`,
      evidence,
      call: { function: fn, de, stackPointer: STACK_POINTER },
      initialMemory,
      biosResponses: [],
      expected: {},
    });
    expectations.push(expectation);
    stepIdentity += 1;
  };

  const writeNewFile = (recordCount: number): void => {
    const identity = nextIdentity++;
    const file: ModelFile = {
      name: encodedName("R", identity),
      records: [],
    };
    push(`make-${identity}`, 22, { kind: "success" }, [
      { address: FCB, bytes: fcbBytes(file.name) },
    ]);
    for (let record = 0; record < recordCount; record += 1) {
      const bytes = recordBytes(seed, identity, record);
      push(`write-${identity}-${record}`, 21, { kind: "zero" }, [
        { address: DMA, bytes },
      ]);
      file.records.push(bytes);
    }
    push(`close-${identity}`, 16, { kind: "success" });
    files.push(file);
  };

  push("reset", 13, { kind: "zero" });
  push(
    "set-dma",
    26,
    { kind: "zero" },
    [{ address: DMA, length: 128, fill: 0xa5 }],
    DMA,
  );
  for (let file = 0; file < 4; file += 1) {
    writeNewFile(1 + (next() % 5));
  }

  for (let transition = 0; transition < 28; transition += 1) {
    const operation = next() % 10;
    const fileIndex = next() % files.length;
    const file = files[fileIndex]!;

    if (operation === 0) {
      const record = next() % file.records.length;
      push(`open-read-${transition}`, 15, { kind: "success" }, [
        { address: FCB, bytes: fcbBytes(file.name) },
      ]);
      push(
        `read-${transition}-${record}`,
        20,
        { kind: "read", bytes: file.records[record]! },
        [{ address: FCB + 32, bytes: [record] }],
      );
      continue;
    }

    if (operation === 1) {
      const record = next() % file.records.length;
      push(`open-rread-${transition}`, 15, { kind: "success" }, [
        { address: FCB, bytes: fcbBytes(file.name) },
      ]);
      push(
        `random-read-${transition}-${record}`,
        33,
        { kind: "read", bytes: file.records[record]! },
        [{ address: FCB + 33, bytes: randomRecordBytes(record) }],
      );
      continue;
    }

    if (operation === 2 && file.records.length < 24) {
      const record = file.records.length;
      const bytes = recordBytes(seed, nextIdentity + transition, record);
      push(`open-append-${transition}`, 15, { kind: "success" }, [
        { address: FCB, bytes: fcbBytes(file.name) },
      ]);
      push(`append-${transition}-${record}`, 21, { kind: "zero" }, [
        { address: FCB + 32, bytes: [record] },
        { address: DMA, bytes },
      ]);
      push(`close-append-${transition}`, 16, { kind: "success" });
      file.records.push(bytes);
      continue;
    }

    if (operation === 3) {
      const record = next() % file.records.length;
      const bytes = recordBytes(seed ^ 0xa5a5a5a5, transition, record);
      push(`open-rwrite-${transition}`, 15, { kind: "success" }, [
        { address: FCB, bytes: fcbBytes(file.name) },
      ]);
      push(`random-write-${transition}-${record}`, 34, { kind: "zero" }, [
        { address: FCB + 33, bytes: randomRecordBytes(record) },
        { address: DMA, bytes },
      ]);
      push(`close-rwrite-${transition}`, 16, { kind: "success" });
      file.records[record] = bytes;
      continue;
    }

    if (operation === 4) {
      push(
        `size-${transition}`,
        35,
        { kind: "size", records: file.records.length },
        [{ address: FCB, bytes: fcbBytes(file.name) }],
      );
      continue;
    }

    if (operation === 5) {
      const attributes = fcbBytes(file.name);
      attributes[11] = attributes[11]! | 0x80;
      push(`attributes-${transition}`, 30, { kind: "success" }, [
        { address: FCB, bytes: attributes },
      ]);
      continue;
    }

    if (operation === 6) {
      const renamed = encodedName("N", nextIdentity++);
      push(`rename-${transition}`, 23, { kind: "success" }, [
        { address: FCB, bytes: fcbBytes(file.name, renamed) },
      ]);
      file.name = renamed;
      continue;
    }

    if (operation === 7 && files.length > 2) {
      push(`delete-${transition}`, 19, { kind: "zero" }, [
        { address: FCB, bytes: fcbBytes(file.name) },
      ]);
      files.splice(fileIndex, 1);
      writeNewFile(1 + (next() % 3));
      continue;
    }

    if (operation === 8) {
      const extent = next() & 0x1f;
      const module = next() & 0x0f;
      const currentRecord = next() & 0x7f;
      const bytes = fcbBytes(file.name);
      bytes[12] = extent;
      bytes[14] = module;
      bytes[32] = currentRecord;
      const records = ((module * 32 + extent) * 128 + currentRecord) >>> 0;
      push(`set-random-${transition}`, 36, { kind: "random-record", records }, [
        { address: FCB, bytes },
      ]);
      continue;
    }

    push(`search-${transition}`, 17, { kind: "success" }, [
      { address: FCB, bytes: fcbBytes(file.name) },
    ]);
  }

  push("search-absent", 17, { kind: "absent" }, [
    { address: FCB, bytes: fcbBytes(encodedName("X", 0xffffff)) },
  ]);

  return {
    fixture: {
      schema: "triptych-bdos-direct-sequence-v1",
      id: `randomized-filesystem-${seed.toString(16)}`,
      description:
        "Seeded model-generated CP/M file lifecycle with exact oracle comparison",
      biosDisk: JSON.parse(JSON.stringify(mutationFixture.biosDisk)),
      steps,
    },
    expectations,
  };
}

function expectModel(
  result: ReturnType<
    typeof runBdosDirectCallSequence
  >["steps"][number]["result"],
  expectation: ModelExpectation,
  context: string,
): void {
  if (expectation.kind === "none") return;
  if (expectation.kind === "zero") {
    expect(result.registers.a, context).toBe(0);
    return;
  }
  if (expectation.kind === "success") {
    expect(result.registers.a, context).not.toBe(0xff);
    return;
  }
  if (expectation.kind === "absent") {
    expect(result.registers.a, context).toBe(0xff);
    return;
  }
  if (expectation.kind === "read") {
    expect(result.registers.a, context).toBe(0);
    expect([...result.memory.slice(DMA, DMA + 128)], context).toEqual(
      expectation.bytes,
    );
    return;
  }
  const expectedRecord = randomRecordBytes(expectation.records);
  expect([...result.memory.slice(FCB + 33, FCB + 36)], context).toEqual(
    expectedRecord,
  );
  expect(result.registers.a, context).toBe(
    expectation.kind === "size" ? 0xff : 0,
  );
}

describe("CP/M 2.2 BDOS randomized filesystem state machine", () => {
  let replacementBdos: Uint8Array;
  let stackBase = 0;
  let stackTop = 0;

  beforeAll(async () => {
    const assembled = await assembleZ80WithLabelsForTest(replacementBdosSource);
    replacementBdos = assembled.bytes;
    stackBase = assembled.labels.STKBASE!;
    stackTop = assembled.labels.STKTOP!;
  });

  it.each([0x13579bdf, 0x2468ace1, 0xc0decafe])(
    "matches the model and oracle for seed %i",
    (seed) => {
      const generated = generatedFilesystemSequence(seed);
      const oracle = runBdosDirectCallSequence(
        referenceBdos,
        generated.fixture,
      );
      const replacement = runBdosDirectCallSequence(
        replacementBdos,
        generated.fixture,
      );
      expect(replacement.steps).toHaveLength(oracle.steps.length);
      expect(generated.expectations).toHaveLength(oracle.steps.length);

      const allowedWrites = new Set<number>([
        ...Array.from({ length: 36 }, (_, offset) => FCB + offset),
        ...Array.from({ length: 128 }, (_, offset) => DMA + offset),
      ]);
      let minimumStack = stackTop;
      replacement.steps.forEach((step, index) => {
        const expected = oracle.steps[index]!;
        const context = `${generated.fixture.id}/${step.id}`;
        expect(step.id, context).toBe(expected.id);
        expect(step.result.stop, context).toBe(expected.result.stop);
        expect(step.result.biosTransferEntry, context).toBe(
          expected.result.biosTransferEntry,
        );
        expect(
          {
            a: step.result.registers.a,
            b: step.result.registers.b,
            h: step.result.registers.h,
            l: step.result.registers.l,
          },
          context,
        ).toEqual({
          a: expected.result.registers.a,
          b: expected.result.registers.b,
          h: expected.result.registers.h,
          l: expected.result.registers.l,
        });
        expect(step.result.biosDisk?.records, context).toEqual(
          expected.result.biosDisk?.records,
        );
        expect([...step.result.memory.slice(FCB, FCB + 36)], context).toEqual([
          ...expected.result.memory.slice(FCB, FCB + 36),
        ]);
        expect(
          [
            ...step.result.memory.slice(
              ALLOCATION_VECTOR,
              ALLOCATION_VECTOR + 31,
            ),
          ],
          context,
        ).toEqual([
          ...expected.result.memory.slice(
            ALLOCATION_VECTOR,
            ALLOCATION_VECTOR + 31,
          ),
        ]);
        expect(
          unexpectedDirectCallWrites(
            step.result,
            generated.fixture.steps[index]!.call.stackPointer,
            allowedWrites,
          ),
          context,
        ).toEqual([]);
        expectModel(step.result, generated.expectations[index]!, context);
        const observedMinimum =
          step.result.minimumResidentStackPointer ?? stackTop;
        expect(observedMinimum, context).toBeGreaterThanOrEqual(stackBase);
        minimumStack = Math.min(minimumStack, observedMinimum);
      });
      expect(stackTop - minimumStack).toBe(10);
    },
  );
});
