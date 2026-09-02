import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type BdosDirectCallFixture,
  type BdosObservedRegisters,
  runBdosDirectCall,
  unexpectedDirectCallWrites,
} from "../support/bdos-direct-call.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const referenceDisk = readFileSync(
  resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img"),
);
const referenceBdos = referenceDisk.subarray(0x0800, 0x1600);
const expectedBdosSha256 =
  "258fe1b659a979fa9adab000fd2ee27b165349179f6b5f5b8b5266ea3385ac22";

function readFixture(name: string): BdosDirectCallFixture {
  return JSON.parse(
    readFileSync(
      resolve(
        repositoryRoot,
        "test",
        "bdos",
        "fixtures",
        "functions",
        `${name}.json`,
      ),
      "utf8",
    ),
  ) as BdosDirectCallFixture;
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

describe("CP/M 2.2 BDOS direct-call contract", () => {
  it.each(["return-version", "console-output", "out-of-range"])(
    "runs the %s fixture against the frozen black-box oracle",
    (fixtureName) => {
      expect(createHash("sha256").update(referenceBdos).digest("hex")).toBe(
        expectedBdosSha256,
      );
      const fixture = readFixture(fixtureName);
      expect(fixture.schema).toBe("triptych-bdos-direct-call-v1");
      expect(fixture.evidence.length).toBeGreaterThan(0);

      const result = runBdosDirectCall(referenceBdos, fixture);
      if (fixture.expected.returnRegisters !== undefined) {
        expectPartialRegisters(
          result.registers,
          fixture.expected.returnRegisters,
        );
      }
      expect(result.biosCalls).toHaveLength(fixture.expected.biosCalls.length);
      fixture.expected.biosCalls.forEach((expectedCall, index) => {
        const observedCall = result.biosCalls[index];
        expect(observedCall?.entry).toBe(expectedCall.entry);
        expect(observedCall?.name).toBe(expectedCall.name);
        if (
          expectedCall.registers !== undefined &&
          observedCall !== undefined
        ) {
          expectPartialRegisters(
            observedCall.registers,
            expectedCall.registers,
          );
        }
      });
      expect(
        unexpectedDirectCallWrites(result, fixture.call.stackPointer),
      ).toEqual([]);
    },
  );
});
