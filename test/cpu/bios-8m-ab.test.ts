import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createEsp32SbcRuntime } from "../../src/cpu/runtime.js";
import { assembleZ80WithLabelsForTest } from "../support/assemble-z80.js";
import { createDebug80TestHarness } from "../support/debug80-runtime.js";

const SIZE = 8 * 1024 * 1024;
let bios: Awaited<ReturnType<typeof assembleZ80WithLabelsForTest>>;
let rom: typeof bios;
beforeAll(async () => {
  bios = await assembleZ80WithLabelsForTest(
    resolve("system/cpm/bios-8m-ab.asm"),
  );
  rom = await assembleZ80WithLabelsForTest(
    resolve("roms/cpu/bootstrap-8m-ab.asm"),
  );
});
const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

function fixture(
  images = [new Uint8Array(SIZE), new Uint8Array(SIZE)],
  cold = false,
  failFlush = -1,
) {
  const harness = createDebug80TestHarness();
  const commands: [number, number, number][] = [];
  const writes: [number, number][] = [];
  let selected = 0;
  let flushFailed = false;
  const machine = createEsp32SbcRuntime({
    bootRom: cold ? rom.bytes : new Uint8Array(256),
    drives: images.map((image) => ({ image })),
    createZ80Runtime: (io) =>
      harness.createRuntime({
        ...io,
        read: (port) =>
          flushFailed && (port & 255) === 0x10 ? 0x14 : (io.read?.(port) ?? 0),
        write: (port, value) => {
          const p = port & 255;
          writes.push([p, value]);
          if (p === 0x11) selected = value;
          if (p === 0x10) {
            commands.push([selected, value, machine.disk.snapshot().record]);
            if (value === 3 && selected === failFlush) {
              flushFailed = true;
              return;
            }
          }
          io.write?.(port, value);
        },
      }),
  });
  const memory = machine.z80.hardware.memory;
  memory.fill(0xa6, 0xfc00);
  if (!cold) {
    machine.z80.hardware.ioWrite(0x20, 0xa5);
    memory.set(bios.bytes, bios.base);
    memory.fill(0xa6, 0xfc00);
  }
  function runTo(pc: number, limit = 30000) {
    let minSp = 0xffff;
    let steps = 0;
    while (
      machine.z80.getPC() !== pc &&
      !harness.captureCpuState().halted &&
      steps++ < limit
    ) {
      machine.z80.step();
      minSp = Math.min(minSp, harness.captureCpuState().sp);
    }
    return { state: harness.captureCpuState(), minSp };
  }
  function enter(label: string, bc = 0) {
    harness.runtime().restoreCpuState({
      ...harness.captureCpuState(),
      pc: bios.labels[label]!,
      sp: label === "WARMBOOT" ? bios.labels.BOOTSP! : 0xd000,
      b: bc >>> 8,
      c: bc & 255,
      d: 0x12,
      e: 1,
      ix: 0x2345,
      iy: 0x3456,
      halted: false,
    });
  }
  function invoke(label: string, bc = 0) {
    memory.set([0, 2], 0xd000);
    enter(label, bc);
    const { state } = runTo(0x200, 4096);
    expect(state.pc).toBe(0x200);
    expect(state.sp).toBe(0xd002);
    expect(state.halted).toBe(false);
    expect(memory.slice(0xfc00)).toEqual(new Uint8Array(1024).fill(0xa6));
    return state;
  }
  return { machine, memory, commands, writes, harness, runTo, enter, invoke };
}

describe("ATOM dual-drive 8 MiB BIOS and bootstrap", () => {
  it("keeps live code, shared work areas, stack, and separate ALVs disjoint", async () => {
    expect(bios.base).toBe(0xf900);
    expect(bios.bytes.length).toBe(1024);
    expect(rom.base).toBe(0);
    expect(rom.bytes.length).toBe(256);
    expect(bios.labels.BOOTSP).toBeLessThanOrEqual(0xfc00);
    expect(bios.labels.DIRBUF! + 128).toBe(bios.labels.BOOTSP! - 32);
    expect(bios.bytes.slice(0x300)).toEqual(new Uint8Array(256));
    const word = (address: number) =>
      bios.bytes[address - bios.base]! |
      (bios.bytes[address - bios.base + 1]! << 8);
    expect(word(bios.labels.DPHEADER! + 14)).toBe(0xfc00);
    expect(word(bios.labels.DPHEADB! + 14)).toBe(0xfe00);
    for (const offset of [8, 10, 12])
      expect(word(bios.labels.DPHEADER! + offset)).toBe(
        word(bios.labels.DPHEADB! + offset),
      );
    expect([
      ...bios.bytes.slice(
        bios.labels.DPBLOCK! - bios.base,
        bios.labels.DPBLOCK! - bios.base + 15,
      ),
    ]).toEqual([128, 0, 4, 15, 0, 247, 15, 255, 1, 255, 0, 0, 0, 1, 0]);
    const legacy = await assembleZ80WithLabelsForTest(
      resolve("system/cpm/bios.asm"),
    );
    expect(digest(legacy.bytes)).toBe(
      "8bb107b756a4794e0f9f7856f42bd236f2d9c8b9380a515eb2dc12a9b55f3414",
    );
  });

  it("publishes distinct DPHs only after full 32-bit capacity validation, preserving caller registers", () => {
    const f = fixture();
    for (const drive of [0, 1, 0]) {
      const state = f.invoke("SELDSK", drive);
      expect((state.h << 8) | state.l).toBe(
        bios.labels[drive ? "DPHEADB" : "DPHEADER"],
      );
      expect([state.b, state.c, state.d, state.e, state.ix, state.iy]).toEqual([
        0,
        drive,
        0x12,
        1,
        0x2345,
        0x3456,
      ]);
      expect(
        [0x12, 0x13, 0x14, 0x15].map((p) => f.machine.disk.readPort(p)),
      ).toEqual([0, 0, 1, 0]);
    }
    for (const drive of [2, 15, 255]) {
      f.writes.length = 0;
      const s = f.invoke("SELDSK", drive);
      expect((s.h << 8) | s.l).toBe(0);
      expect(f.writes).toEqual([]);
      expect(f.memory[bios.labels.CURDRIVE!]).toBe(0);
    }
  });

  it.each([0, 256512, SIZE - 512, SIZE + 512])(
    "rejects absent/wrong-size B (%i bytes) without aliasing A",
    (size) => {
      const a = new Uint8Array(SIZE).fill(0x35);
      const f = fixture(size ? [a, new Uint8Array(size).fill(0x79)] : [a]);
      f.invoke("SELDSK", 0);
      const s = f.invoke("SELDSK", 1);
      expect((s.h << 8) | s.l).toBe(0);
      expect(f.memory[bios.labels.CURDRIVE!]).toBe(0);
      f.invoke("SETDMA", 0x4000);
      expect(f.invoke("READSEC").a).toBe(0);
      expect(f.memory.slice(0x4000, 0x4080)).toEqual(
        new Uint8Array(128).fill(0x35),
      );
    },
  );

  it.each([0, 127, 128, 255, 256, 65534, 65535])(
    "isolates A/B writes and first/last boundaries at record %i",
    (record) => {
      const images = [
        new Uint8Array(SIZE).fill(0x31),
        new Uint8Array(SIZE).fill(0x72),
      ];
      const f = fixture(images);
      for (const drive of [1, 0, 1]) {
        f.invoke("SELDSK", drive);
        f.invoke("SETTRACK", Math.floor(record / 128));
        f.invoke("SETSEC", (record % 128) + 1);
        f.invoke("SETDMA", 0x4000);
        expect(f.invoke("READSEC").a).toBe(0);
        expect(f.memory.slice(0x4000, 0x4080)).toEqual(
          images[drive]!.slice(record * 128, record * 128 + 128),
        );
        f.memory.fill(0x85 + drive, 0x4000, 0x4080);
        expect(f.invoke("WRITESEC").a).toBe(0);
        images[drive]!.fill(0x85 + drive, record * 128, record * 128 + 128);
        expect(f.machine.disk.exportPersistentImages().map(digest)).toEqual(
          images.map(digest),
        );
      }
    },
  );

  it("rejects I/O before a successful binding and invalid coordinates before any ports", () => {
    const f = fixture();
    f.writes.length = 0;
    expect(f.invoke("READSEC").a).toBe(1);
    expect(f.writes).toEqual([]);
    f.invoke("SELDSK", 1);
    for (const [track, sector] of [
      [0, 0],
      [0, 129],
      [0, 256],
      [512, 1],
      [65535, 128],
    ]) {
      f.invoke("SETTRACK", track);
      f.invoke("SETSEC", sector);
      f.writes.length = 0;
      expect(f.invoke("READSEC").a).toBe(1);
      expect(f.invoke("WRITESEC").a).toBe(1);
      expect(f.writes).toEqual([]);
    }
  });

  it.each([0, 256512, SIZE])(
    "warm-boots from A with optional %i-byte B, issues FLUSH for every present drive and preserves default/ALVs",
    (size) => {
      const a = new Uint8Array(SIZE).fill(0x39);
      const f = fixture(size ? [a, new Uint8Array(size).fill(0x72)] : [a]);
      if (size === SIZE) f.invoke("SELDSK", 1);
      if (size) {
        const io = f.machine.z80.hardware.ioWrite;
        io(0x11, 1);
        for (const port of [0x12, 0x13, 0x14, 0x15]) io(port, 0);
        io(0x10, 2);
        for (let i = 0; i < 128; i++) io(0x16, 0x87);
        expect(f.machine.disk.snapshot().cacheDirty).toBe(true);
      }
      f.memory[4] = size === SIZE ? 1 : 0;
      f.commands.length = 0;
      f.enter("WARMBOOT");
      const { state, minSp } = f.runTo(0xe300);
      expect(state.pc).toBe(0xe300);
      expect(state.c).toBe(size === SIZE ? 1 : 0);
      expect(state.sp).toBe(bios.labels.BOOTSP);
      expect(minSp).toBeGreaterThanOrEqual(bios.labels.BOOTSP! - 32);
      expect(minSp).toBe(bios.labels.BOOTSP! - 4);
      expect(f.memory.slice(0xf900, bios.labels.BOOTREC!)).toEqual(
        bios.bytes.slice(0, bios.labels.BOOTREC! - bios.base),
      );
      expect(f.memory.slice(0xe300, 0xf900)).toEqual(a.slice(0, 44 * 128));
      expect(f.memory.slice(0xfc00)).toEqual(new Uint8Array(1024).fill(0xa6));
      expect([...f.memory.slice(5, 8)]).toEqual([0xc3, 6, 0xeb]);
      expect(f.commands.filter(([, cmd]) => cmd === 3).map(([d]) => d)).toEqual(
        size ? [0, 1] : [0],
      );
      const firstRead = f.commands.findIndex(([, cmd]) => cmd === 1);
      expect(f.commands.slice(firstRead)).toEqual(
        Array.from({ length: 44 }, (_, r) => [0, 1, r]),
      );
      if (size)
        expect(
          f.machine.disk.exportPersistentImages()[1]!.slice(0, 128),
        ).toEqual(new Uint8Array(128).fill(0x87));
    },
  );

  it("rejects incompatible mandatory A before flushing or overwriting resident memory", () => {
    const f = fixture([new Uint8Array(256512), new Uint8Array(SIZE)]);
    f.memory.fill(0x59, 0xe300, 0xf900);
    f.enter("WARMBOOT");
    expect(f.runTo(0xe300).state.halted).toBe(true);
    expect(f.commands.map(([drive, command]) => [drive, command])).toEqual([
      [0, 4],
    ]);
    expect(f.memory.slice(0xe300, 0xf900)).toEqual(
      new Uint8Array(44 * 128).fill(0x59),
    );
  });

  it.each([0, 1])(
    "stops on drive %i flush failure before any resident reload or later command",
    (drive) => {
      const f = fixture(undefined, false, drive);
      f.memory.fill(0x59, 0xe300, 0xf900);
      f.enter("WARMBOOT");
      const { state } = f.runTo(0xe300);
      expect(state.halted).toBe(true);
      expect(f.commands.at(-1)?.slice(0, 2)).toEqual([drive, 3]);
      expect(f.commands.some(([, cmd]) => cmd === 1)).toBe(false);
      expect(f.memory.slice(0xe300, 0xf900)).toEqual(
        new Uint8Array(44 * 128).fill(0x59),
      );
      expect(f.memory.slice(0xfc00)).toEqual(new Uint8Array(1024).fill(0xa6));
    },
  );

  it("cold-loads exactly 52 A records through the new ROM, then enters CCP with the overlay disabled", () => {
    const a = new Uint8Array(SIZE).fill(0x39);
    a.set(bios.bytes, 44 * 128);
    const f = fixture([a, new Uint8Array(SIZE).fill(0x72)], true);
    const { state } = f.runTo(0xe300);
    expect(state.pc).toBe(0xe300);
    expect(state.c).toBe(0);
    expect(state.sp).toBe(bios.labels.BOOTSP);
    expect(f.commands).toEqual(Array.from({ length: 52 }, (_, r) => [0, 1, r]));
    expect(f.memory.slice(0xe300, 0xf900)).toEqual(a.slice(0, 44 * 128));
    expect(f.memory.slice(0xfc00, 0xfd00)).toEqual(new Uint8Array(256));
    expect(f.memory.slice(0xfd00)).toEqual(new Uint8Array(768).fill(0xa6));
    expect(f.writes).toContainEqual([0x20, 0xa5]);
    expect([...f.memory.slice(5, 8)]).toEqual([0xc3, 6, 0xeb]);
    expect(f.memory[0xe1f0]).toBe(52);
    expect(f.memory[0xe1f1]).toBe(0);
  });
});
