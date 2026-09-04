import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createEsp32SbcRuntime } from "../../src/cpu/runtime.js";
import { assembleZ80ForTest } from "../support/assemble-z80.js";
import { createDebug80TestHarness } from "../support/debug80-runtime.js";

const repositoryRoot = resolve(import.meta.dirname, "..", "..");
const systemBdosOffset = 0x0800;
const systemBiosOffset = 0x1600;
const backingSectorBytes = 512;
let bootRom: Uint8Array;
let replacementBdos: Uint8Array;
let bios: Uint8Array;
let consoleProgram: Uint8Array;

function outputText(output: readonly number[], offset = 0): string {
  return Buffer.from(output.slice(offset)).toString("latin1");
}

function stepUntil(
  step: () => void,
  predicate: () => boolean,
  description: string,
): void {
  for (let count = 0; count < 5_000_000; count += 1) {
    step();
    if (predicate()) return;
  }
  throw new Error(`timed out waiting for ${description}`);
}

describe("Triptych BDOS console transient", () => {
  beforeAll(async () => {
    [bootRom, replacementBdos, bios, consoleProgram] = await Promise.all([
      assembleZ80ForTest(resolve(repositoryRoot, "roms/cpu/bootstrap.asm")),
      assembleZ80ForTest(resolve(repositoryRoot, "roms/cpu/bdos/bdos.asm")),
      assembleZ80ForTest(resolve(repositoryRoot, "system/cpm/bios.asm")),
      assembleZ80ForTest(
        resolve(repositoryRoot, "test/bdos/programs/console-smoke.asm"),
      ),
    ]);
  });

  it("runs a directly loaded COM-shaped program and warm-boots to the CCP", () => {
    const sourceDisk = readFileSync(
      resolve(repositoryRoot, "third_party/cpm22/cpm22.img"),
    );
    const disk = new Uint8Array(
      Math.ceil(sourceDisk.length / backingSectorBytes) * backingSectorBytes,
    );
    disk.set(sourceDisk);
    disk.set(replacementBdos, systemBdosOffset);
    disk.set(bios, systemBiosOffset);

    const harness = createDebug80TestHarness();
    const machine = createEsp32SbcRuntime({
      bootRom,
      drives: [{ image: disk }],
      createZ80Runtime: harness.createRuntime,
    });

    stepUntil(
      () => {
        machine.z80.step();
      },
      () => outputText(machine.serial.snapshot().output).endsWith("\r\nA>"),
      "initial CCP prompt",
    );
    expect(outputText(machine.serial.snapshot().output)).toBe("\r\nA>");
    const outputStart = machine.serial.snapshot().output.length;

    machine.z80.hardware.memory.set(consoleProgram, 0x0100);
    const state = harness.captureCpuState();
    state.pc = 0x0100;
    state.sp = 0xe300;
    state.halted = false;
    harness.runtime().restoreCpuState(state);

    stepUntil(
      () => {
        machine.z80.step();
      },
      () =>
        outputText(machine.serial.snapshot().output, outputStart).endsWith(
          "\r\nA>",
        ),
      "transient output and warm-boot prompt",
    );
    expect(outputText(machine.serial.snapshot().output, outputStart)).toBe(
      "TRIPTYCH BDOS\r\n\r\nA>",
    );
    expect(machine.memory.snapshot().bootRomEnabled).toBe(false);
  });
});
