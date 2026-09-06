import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createEsp32SbcRuntime } from "../../src/cpu/runtime.js";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { createDebug80TestHarness } from "../support/debug80-runtime.js";

const IMAGE_BYTES = 8 * 1024 * 1024;
let bios: Awaited<ReturnType<typeof assembleZ80WithLabelsForTest>>;

beforeAll(async () => {
  bios = await assembleZ80WithLabelsForTest(resolve("system/cpm/bios-8m.asm"));
});

function fixture(image = new Uint8Array(IMAGE_BYTES)) {
  const harness = createDebug80TestHarness();
  const writes: [number, number][] = [];
  const machine = createEsp32SbcRuntime({
    bootRom: new Uint8Array(256),
    drives: [{ image }],
    createZ80Runtime: (io) =>
      harness.createRuntime({
        ...io,
        write: (port, value) => {
          writes.push([port & 255, value]);
          io.write?.(port, value);
        },
      }),
  });
  const memory = machine.z80.hardware.memory;
  machine.z80.hardware.ioWrite(0x20, 0xa5);
  memory.set(bios.bytes, bios.base);
  memory.fill(0xa6, 0xfe00);
  function invoke(label: string, bc = 0) {
    const pc = bios.labels[label];
    expect(pc, label).toBeDefined();
    memory[0xd000] = 0;
    memory[0xd001] = 2;
    harness.runtime().restoreCpuState({
      ...harness.captureCpuState(),
      pc: pc!,
      sp: 0xd000,
      b: bc >>> 8,
      c: bc & 255,
      halted: false,
    });
    for (let n = 0; n < 4096 && machine.z80.getPC() !== 0x200; n++)
      machine.z80.step();
    const state = harness.captureCpuState();
    expect(state.pc).toBe(0x200);
    expect(state.sp).toBe(0xd002);
    expect(state.halted).toBe(false);
    expect(memory.slice(0xfe00)).toEqual(new Uint8Array(512).fill(0xa6));
    return state;
  }
  return { machine, memory, writes, invoke };
}

describe("ATOM one-drive 8 MiB BIOS", () => {
  it("retains the legacy BIOS bytes and fits the new loaded/runtime regions", async () => {
    const legacy = await assembleZ80WithLabelsForTest(
      resolve("system/cpm/bios.asm"),
    );
    expect(createHash("sha256").update(legacy.bytes).digest("hex")).toBe(
      "8bb107b756a4794e0f9f7856f42bd236f2d9c8b9380a515eb2dc12a9b55f3414",
    );
    expect(bios.base).toBe(0xfa00);
    expect(bios.bytes.length).toBe(1024);
    expect(bios.labels.BOOTSP).toBeLessThanOrEqual(0xfe00);
    expect(bios.labels.DIRBUF! + 128).toBeLessThanOrEqual(
      bios.labels.BOOTSP! - 32,
    );
    const offset = bios.labels.DPBLOCK! - bios.base;
    expect([...bios.bytes.slice(offset, offset + 15)]).toEqual([
      128, 0, 4, 15, 0, 247, 15, 255, 1, 255, 0, 0, 0, 1, 0,
    ]);
    const dph = bios.labels.DPHEADER! - bios.base;
    expect([...bios.bytes.slice(dph + 14, dph + 16)]).toEqual([0, 254]);
  });

  it("accepts a 32-bit capacity of 65536 records and rejects other drives", () => {
    const f = fixture();
    const accepted = f.invoke("SELDSK", 0);
    expect((accepted.h << 8) | accepted.l).toBe(bios.labels.DPHEADER);
    expect(
      [0x12, 0x13, 0x14, 0x15].map((p) => f.machine.disk.readPort(p)),
    ).toEqual([0, 0, 1, 0]);
    f.writes.length = 0;
    const rejected = f.invoke("SELDSK", 1);
    expect((rejected.h << 8) | rejected.l).toBe(0);
    expect(f.writes).toEqual([]);
  });

  it.each([256512, IMAGE_BYTES - 512, IMAGE_BYTES + 512])(
    "rejects an incompatible %i-byte capacity without a record command",
    (length) => {
      const f = fixture(new Uint8Array(length));
      f.writes.length = 0;
      const state = f.invoke("SELDSK");
      expect((state.h << 8) | state.l).toBe(0);
      expect(f.writes.filter(([port]) => port === 0x10)).toEqual([[0x10, 4]]);
    },
  );

  it.each([0, 127, 128, 255, 256, 16384, 65534, 65535])(
    "reads and flushes exact record %i, preserving its neighbours",
    (record) => {
      const image = new Uint8Array(IMAGE_BYTES).fill(0x39);
      image.fill(0x71, record * 128, record * 128 + 128);
      const f = fixture(image);
      f.invoke("SELDSK");
      f.invoke("SETTRACK", Math.floor(record / 128));
      f.invoke("SETSEC", (record % 128) + 1);
      f.invoke("SETDMA", 0x4000);
      expect(f.invoke("READSEC").a).toBe(0);
      expect(f.memory.slice(0x4000, 0x4080)).toEqual(
        new Uint8Array(128).fill(0x71),
      );
      f.memory.fill(0x85, 0x4000, 0x4080);
      expect(f.invoke("WRITESEC").a).toBe(0);
      image.fill(0x85, record * 128, record * 128 + 128);
      const actual = f.machine.disk.exportPersistentImages()[0]!;
      expect(createHash("sha256").update(actual).digest("hex")).toBe(
        createHash("sha256").update(image).digest("hex"),
      );
    },
  );

  it.each([
    [0, 0],
    [0, 129],
    [0, 256],
    [0, 65535],
    [512, 1],
    [65535, 128],
  ])("rejects track %i sector %i before issuing I/O", (track, sector) => {
    const f = fixture();
    f.invoke("SETTRACK", track);
    f.invoke("SETSEC", sector);
    f.writes.length = 0;
    expect(f.invoke("READSEC").a).toBe(1);
    expect(f.invoke("WRITESEC").a).toBe(1);
    expect(f.writes).toEqual([]);
  });
});
