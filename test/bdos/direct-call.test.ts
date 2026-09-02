import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  type BdosDirectCallFixture,
  type BdosDirectCallResult,
  type BdosDirectCallSequenceFixture,
  type BdosObservedRegisters,
  bdosBiosConsoleOutput,
  bdosBiosTraceSha256,
  materializeBdosBytePattern,
  materializeBdosMemoryPatch,
  runBdosDirectCall,
  runBdosDirectCallSequence,
  unexpectedDirectCallWrites,
} from "../support/bdos-direct-call.js";
import { assembleZ80ForTest } from "../support/assemble-z80.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const referenceDisk = readFileSync(
  resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img"),
);
const referenceBdos = referenceDisk.subarray(0x0800, 0x1600);
const expectedBdosSha256 =
  "258fe1b659a979fa9adab000fd2ee27b165349179f6b5f5b8b5266ea3385ac22";
const replacementBdosSource = resolve(
  repositoryRoot,
  "roms",
  "cpu",
  "bdos",
  "bdos.asm",
);
let replacementBdos: Uint8Array;
const functionFixtureDirectory = resolve(
  repositoryRoot,
  "test",
  "bdos",
  "fixtures",
  "functions",
);
const fixtureNames = readdirSync(functionFixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();
const sequenceFixtureDirectory = resolve(
  repositoryRoot,
  "test",
  "bdos",
  "fixtures",
  "sequences",
);
const sequenceFixtureNames = readdirSync(sequenceFixtureDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort();
const replacementSequenceFixtureNames = sequenceFixtureNames.filter((name) =>
  [
    "absent-drive.json",
    "console-state-roundtrip.json",
    "disk-geometry-discovery.json",
    "disk-state-roundtrip.json",
    "io-byte-roundtrip.json",
  ].includes(name),
);

function readFixture(name: string): BdosDirectCallFixture {
  return JSON.parse(
    readFileSync(resolve(functionFixtureDirectory, name), "utf8"),
  ) as BdosDirectCallFixture;
}

function readSequenceFixture(name: string): BdosDirectCallSequenceFixture {
  return JSON.parse(
    readFileSync(resolve(sequenceFixtureDirectory, name), "utf8"),
  ) as BdosDirectCallSequenceFixture;
}

function expectPartialRegisters(
  observed: BdosObservedRegisters,
  expected: Partial<BdosObservedRegisters>,
): void {
  for (const register of Object.keys(expected) as Array<
    keyof BdosObservedRegisters
  >) {
    expect(observed[register], register).toBe(expected[register]);
  }
}

function expectFixtureResult(
  fixture:
    BdosDirectCallFixture | BdosDirectCallSequenceFixture["steps"][number],
  result: BdosDirectCallResult,
): void {
  expect(result.stop).toBe(fixture.expected.stop ?? "normal-return");
  expect(result.biosTransferEntry).toBe(fixture.expected.biosTransferEntry);
  if (fixture.expected.returnRegisters !== undefined) {
    expectPartialRegisters(result.registers, fixture.expected.returnRegisters);
  }
  if (fixture.expected.biosCalls !== undefined) {
    expect(result.biosCalls).toHaveLength(fixture.expected.biosCalls.length);
    fixture.expected.biosCalls.forEach((expectedCall, index) => {
      const observedCall = result.biosCalls[index];
      expect(observedCall?.entry).toBe(expectedCall.entry);
      expect(observedCall?.name).toBe(expectedCall.name);
      if (expectedCall.registers !== undefined && observedCall !== undefined) {
        expectPartialRegisters(observedCall.registers, expectedCall.registers);
      }
    });
  }
  if (fixture.expected.biosCallCount !== undefined) {
    expect(result.biosCalls, `${fixture.id} BIOS calls`).toHaveLength(
      fixture.expected.biosCallCount,
    );
  }
  if (fixture.expected.biosTraceSha256 !== undefined) {
    expect(
      bdosBiosTraceSha256(result.biosCalls),
      `${fixture.id} BIOS trace`,
    ).toBe(fixture.expected.biosTraceSha256);
  }
  if (
    fixture.expected.biosConsoleOutputAscii !== undefined ||
    fixture.expected.biosConsoleOutputBytes !== undefined
  ) {
    expect(
      (fixture.expected.biosConsoleOutputAscii === undefined) !==
        (fixture.expected.biosConsoleOutputBytes === undefined),
      "fixture must define exactly one BIOS console-output representation",
    ).toBe(true);
    for (const character of fixture.expected.biosConsoleOutputAscii ?? "") {
      expect(
        character.codePointAt(0),
        `${fixture.id} BIOS console ASCII must be 7-bit`,
      ).toBeLessThanOrEqual(0x7f);
    }
    for (const byte of fixture.expected.biosConsoleOutputBytes ?? []) {
      expect(
        Number.isInteger(byte) && byte >= 0 && byte <= 0xff,
        `${fixture.id} BIOS console byte must be an integer from 0 through 255`,
      ).toBe(true);
    }
    const expectedOutput =
      fixture.expected.biosConsoleOutputBytes === undefined
        ? Uint8Array.from(
            Buffer.from(fixture.expected.biosConsoleOutputAscii ?? "", "ascii"),
          )
        : Uint8Array.from(fixture.expected.biosConsoleOutputBytes);
    expect([...bdosBiosConsoleOutput(result.biosCalls)]).toEqual([
      ...expectedOutput,
    ]);
  }
  if (fixture.expected.biosDiskState !== undefined) {
    expect(result.biosDisk).toBeDefined();
    for (const field of Object.keys(fixture.expected.biosDiskState) as Array<
      keyof NonNullable<typeof fixture.expected.biosDiskState>
    >) {
      expect(result.biosDisk?.[field], `BIOS disk ${field}`).toBe(
        fixture.expected.biosDiskState[field],
      );
    }
  }
  if (fixture.expected.biosDiskWriteCount !== undefined) {
    expect(result.biosDisk, "BIOS disk snapshot").toBeDefined();
    expect(result.biosDisk?.writes, "BIOS disk writes").toHaveLength(
      fixture.expected.biosDiskWriteCount,
    );
  }
  for (const expectedRecord of fixture.expected.biosDiskRecords ?? []) {
    const observedRecord = result.biosDisk?.records.find(
      (candidate) =>
        candidate.drive === expectedRecord.drive &&
        candidate.record === expectedRecord.record,
    );
    expect(
      observedRecord,
      `BIOS disk record ${expectedRecord.drive}:${expectedRecord.record}`,
    ).toBeDefined();
    const expectedBytes = materializeBdosBytePattern(
      expectedRecord,
      `BIOS disk record ${expectedRecord.drive}:${expectedRecord.record}`,
    );
    expect(expectedBytes).toHaveLength(128);
    expect(observedRecord?.bytes).toEqual([...expectedBytes]);
  }

  const allowedAddresses = new Set<number>();
  for (const patch of fixture.expected.memory ?? []) {
    const bytes = materializeBdosMemoryPatch(patch);
    expect(
      [...result.memory.slice(patch.address, patch.address + bytes.length)],
      `memory at ${patch.address.toString(16)}`,
    ).toEqual([...bytes]);
    for (let offset = 0; offset < bytes.length; offset += 1) {
      allowedAddresses.add(patch.address + offset);
    }
  }
  expect(
    unexpectedDirectCallWrites(
      result,
      fixture.call.stackPointer,
      allowedAddresses,
    ),
  ).toEqual([]);
}

describe("CP/M 2.2 BDOS direct-call contract", () => {
  beforeAll(async () => {
    replacementBdos = await assembleZ80ForTest(replacementBdosSource);
    expect(replacementBdos).toHaveLength(0x0e00);
  });

  it("has at least one fixture for every function from 0 through 40", () => {
    const covered = new Set([
      ...fixtureNames.map(
        (fixtureName) => readFixture(fixtureName).call.function,
      ),
      ...sequenceFixtureNames.flatMap((fixtureName) =>
        readSequenceFixture(fixtureName).steps.map(
          (step) => step.call.function,
        ),
      ),
    ]);
    expect(
      [...covered]
        .filter((functionNumber) => functionNumber <= 40)
        .sort((left, right) => left - right),
    ).toEqual(Array.from({ length: 41 }, (_, index) => index));
  });

  it.each(fixtureNames)(
    "runs the %s fixture against the frozen black-box oracle",
    (fixtureName) => {
      expect(createHash("sha256").update(referenceBdos).digest("hex")).toBe(
        expectedBdosSha256,
      );
      const fixture = readFixture(fixtureName);
      expect(fixture.schema).toBe("triptych-bdos-direct-call-v1");
      expect(fixture.evidence.length).toBeGreaterThan(0);

      const result = runBdosDirectCall(referenceBdos, fixture);
      expectFixtureResult(fixture, result);
    },
  );

  it.each(fixtureNames)(
    "runs the %s fixture against the current Triptych replacement",
    (fixtureName) => {
      const fixture = readFixture(fixtureName);
      const result = runBdosDirectCall(replacementBdos, fixture);
      expectFixtureResult(fixture, result);
    },
  );

  it.each(sequenceFixtureNames)(
    "runs the %s stateful fixture against the frozen black-box oracle",
    (fixtureName) => {
      const fixture = readSequenceFixture(fixtureName);
      expect(fixture.schema).toBe("triptych-bdos-direct-sequence-v1");
      const result = runBdosDirectCallSequence(referenceBdos, fixture);
      expect(result.steps).toHaveLength(fixture.steps.length);
      fixture.steps.forEach((step, index) => {
        expect(step.evidence.length).toBeGreaterThan(0);
        expect(result.steps[index]?.id).toBe(step.id);
        expectFixtureResult(step, result.steps[index]!.result);
      });
    },
  );

  it.each(replacementSequenceFixtureNames)(
    "runs the %s implemented stateful fixture against the Triptych replacement",
    (fixtureName) => {
      const fixture = readSequenceFixture(fixtureName);
      const result = runBdosDirectCallSequence(replacementBdos, fixture);
      fixture.steps.forEach((step, index) => {
        expectFixtureResult(step, result.steps[index]!.result);
      });
    },
  );

  it("keeps the replacement private stack inside its reserved 64 bytes", () => {
    const results = [
      ...fixtureNames.map((name) =>
        runBdosDirectCall(replacementBdos, readFixture(name)),
      ),
      ...replacementSequenceFixtureNames.flatMap((name) =>
        runBdosDirectCallSequence(
          replacementBdos,
          readSequenceFixture(name),
        ).steps.map(({ result }) => result),
      ),
    ];
    const minimum = Math.min(
      ...results.map((result) => result.minimumResidentStackPointer ?? 0xffff),
    );
    expect(minimum).toBeGreaterThanOrEqual(0xf1ad);
    expect(0xf1ed - minimum).toBe(14);
  });
});
