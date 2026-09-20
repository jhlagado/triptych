import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { assembleAtomFile } from "../../tools/lib/assemble-atom.mjs";
import { createDebug80TestHarness } from "../support/debug80-runtime.ts";

let program;
beforeAll(async () => {
  program = await assembleAtomFile(
    resolve(import.meta.dirname, "../../apps/copy/copy.asm"),
  );
});

// Execute the real ATOM artifact, intercepting only the public BDOS boundary.
// Failure injection distinguishes cleanup paths that a healthy disk cannot.
function run(tail, { records = 3, fail, declaredLength } = {}) {
  const harness = createDebug80TestHarness();
  harness.createRuntime({});
  const runtime = harness.runtime();
  const memory = runtime.hardware.memory;
  memory.set(program.bytes, program.base);
  memory[5] = 0xc9;
  memory[0x80] = declaredLength ?? tail.length;
  memory.set(Buffer.from(tail, "latin1"), 0x81);
  memory[0xf000] = 0x00;
  memory[0xf001] = 0xff;
  const state = runtime.captureCpuState();
  Object.assign(state, { pc: 0x100, sp: 0xf000, ix: 0x1234, iy: 0x5678 });
  runtime.restoreCpuState(state);
  let output = "";
  let dma = 0x80;
  let read = 0;
  let made = false;
  let deleted = false;
  const writes = [];
  const calls = [];
  const source = Uint8Array.from({ length: records * 128 }, (_, i) => i % 251);
  for (let step = 0; runtime.getPC() !== 0xff00; step++) {
    if (step > 1_000_000) throw new Error("COPY failed to return");
    if (runtime.getPC() === 5) {
      const cpu = runtime.captureCpuState();
      const address = (cpu.d << 8) | cpu.e;
      const name = Buffer.from(memory.slice(address, address + 12)).toString(
        "latin1",
      );
      const call = { fn: cpu.c, address, name };
      calls.push(call);
      let result = fail?.(call, calls);
      if (result === undefined) {
        result = 0;
        switch (cpu.c) {
          case 9:
            for (let p = address; memory[p] !== 36; p++) {
              if (p >= 0x10000) throw new Error("unterminated message");
              output += String.fromCharCode(memory[p]);
            }
            break;
          case 15:
            result = address === program.labels.SRCFCB ? 0 : 255;
            break;
          case 16:
            break;
          case 19:
            deleted = true;
            break;
          case 20:
            if (read === records) result = 1;
            else memory.set(source.slice(read++ * 128, read * 128), dma);
            break;
          case 21:
            writes.push(memory.slice(dma, dma + 128));
            break;
          case 22:
            made = true;
            break;
          case 26:
            dma = address;
            break;
          default:
            throw new Error(`unexpected BDOS call ${cpu.c}`);
        }
      }
      // BDOS callers cannot depend on working registers surviving a call.
      Object.assign(cpu, {
        a: result,
        b: 0xa5,
        c: 0xa5,
        d: 0xa5,
        e: 0xa5,
        h: 0xa5,
        l: 0xa5,
        ix: 0xa5a5,
        iy: 0xa5a5,
      });
      runtime.restoreCpuState(cpu);
    }
    runtime.step();
  }
  expect(runtime.captureCpuState().sp).toBe(0xf002);
  expect(runtime.captureCpuState().ix).toBe(0x1234);
  expect(runtime.captureCpuState().iy).toBe(0x5678);
  return { output, calls, source, writes, made, deleted };
}

describe("COPY.COM public BDOS contract", () => {
  it.each([0, 1, 3, 129])("copies exactly %i binary records", (records) => {
    const result = run(" A:SOURCE.BIN B:TARGET.BIN", { records });
    expect(result.output).toContain("1 file copied");
    expect(Buffer.concat(result.writes)).toEqual(Buffer.from(result.source));
    expect(result.calls.find((c) => c.fn === 15).name).toBe("\x01SOURCE  BIN");
    expect(result.calls.find((c) => c.fn === 22).name).toBe("\x02TARGET  BIN");
    expect(result.deleted).toBe(false);
  });

  it.each([
    "",
    " A B C",
    " A*.TXT B.TXT",
    " A.TXT B?.TXT",
    " A/B.TXT C.TXT",
    " A\\B.TXT C.TXT",
    " A;B C",
    " A,B C",
    " .TXT B",
    " A. B",
    " TOOLONG99.TXT B",
    " A.LONG B",
    " Q:A B",
    " A:B C:D:E",
    " A B[",
    " A B\x7f",
  ])("rejects malformed input %j before disk access", (tail) => {
    const result = run(tail);
    expect(result.output).toContain("COPY source destination");
    expect(result.calls.map((c) => c.fn)).toEqual([9]);
  });

  it("rejects an oversized command tail before copying it", () => {
    expect(run(" A B", { declaredLength: 255 }).output).toContain(
      "COPY source destination",
    );
  });

  it("never makes or deletes an existing destination", () => {
    const result = run(" A B", { fail: (c) => (c.fn === 15 ? 0 : undefined) });
    expect(result.output).toContain("destination exists");
    expect(result.made).toBe(false);
    expect(result.deleted).toBe(false);
  });

  it("does not touch a destination when the source is missing", () => {
    const result = run(" A B", {
      fail: (c) => (c.fn === 15 ? 255 : undefined),
    });
    expect(result.output).toContain("source not found");
    expect(result.made).toBe(false);
    expect(result.deleted).toBe(false);
  });

  it.each([20, 21, 16])("removes a partial copy on BDOS %i failure", (fn) => {
    let failed = false;
    const result = run(" A B", {
      fail: (call) => {
        if (call.fn === fn && !failed) {
          failed = true;
          return fn === 16 ? 255 : 2;
        }
      },
    });
    expect(result.output).toContain("disk error");
    expect(result.deleted).toBe(true);
  });

  it("removes the destination if closing the source fails", () => {
    let failed = false;
    const result = run(" A B", {
      fail: (call) => {
        if (
          call.fn === 16 &&
          call.address === program.labels.SRCFCB &&
          !failed
        ) {
          failed = true;
          return 255;
        }
      },
    });
    expect(result.output).toContain("disk error");
    expect(result.deleted).toBe(true);
  });

  it("does not delete anything if creation fails", () => {
    const result = run(" A B", {
      fail: (c) => (c.fn === 22 ? 255 : undefined),
    });
    expect(result.output).toContain("disk error");
    expect(result.deleted).toBe(false);
  });
});
