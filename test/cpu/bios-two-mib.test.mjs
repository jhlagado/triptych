import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { createEsp32SbcRuntime } from "../../src/cpu/runtime.js";
import { createDebug80TestHarness } from "../support/debug80-runtime.js";
import { assembleAtomFile } from "../../tools/lib/assemble-atom.mjs";
import {
  assembleTwoMibProfile,
  prepareTwoMibSources,
  twoMibResidentProfile,
} from "../../tools/lib/cpm-two-mib-profile.mjs";

const SIZE = 2 * 1024 * 1024;
const COUNTS = Array.from({ length: 16 }, (_, index) => index + 1);
const builds = new Map();
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
beforeAll(async () => {
  for (const count of COUNTS)
    builds.set(count, await assembleTwoMibProfile(count));
}, 60_000);

// Every record differs, including neighboring quarters of a cache sector.
// These are transfer fixtures, not executable CCP/BDOS replacement artifacts.
function imageFor(drive, bytes = SIZE) {
  const image = new Uint8Array(bytes).fill(0x30 + drive);
  for (let offset = 0; offset < bytes; offset += 128) {
    const record = offset / 128;
    image[offset] = record & 255;
    image[offset + 1] = (record >>> 8) & 255;
    image[offset + 126] = drive;
    image[offset + 127] = (record + 0x47) & 255;
  }
  return image;
}

function fixture(count, options = {}) {
  const { profile, bios, bootstrap } = builds.get(count);
  const images =
    options.images ?? Array.from({ length: count }, (_, i) => imageFor(i));
  if (options.cold) images[0].set(bios.bytes, 44 * 128);
  const harness = createDebug80TestHarness();
  const commands = [];
  const writes = [];
  let selected = 0;
  let injectedError = false;
  const machine = createEsp32SbcRuntime({
    bootRom: options.cold ? bootstrap.bytes : new Uint8Array(256),
    drives: images.map((image) => ({ image })),
    createZ80Runtime: (io) =>
      harness.createRuntime({
        ...io,
        read: (port) => {
          if (injectedError && (port & 255) === 0x10) return 0x14;
          if (
            options.capacityBytes &&
            (port & 255) >= 0x12 &&
            (port & 255) <= 0x15
          )
            return options.capacityBytes[(port & 255) - 0x12];
          return io.read?.(port) ?? 0;
        },
        write: (port, value) => {
          const p = port & 255;
          writes.push([p, value]);
          if (p === 0x11) selected = value;
          if (p === 0x10) {
            const record = machine.disk.snapshot().record;
            commands.push([selected, value, record]);
            if (
              (value === 3 && selected === options.failFlush) ||
              (value === 1 && record === options.failRead)
            ) {
              // This injection qualifies BIOS control flow at the port boundary.
              // It is not a Rust provider or browser transaction-failure proof.
              injectedError = true;
              return;
            }
          }
          io.write?.(port, value);
        },
      }),
  });
  const memory = machine.z80.hardware.memory;
  memory.fill(0xa6, profile.allocationBase);
  if (!options.cold) {
    machine.z80.hardware.ioWrite(0x20, 0xa5);
    memory.set(bios.bytes, bios.base);
  }
  function runTo(pc, limit = 40_000) {
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
    return { ...harness.captureCpuState(), minSp };
  }
  function enter(label, bc = 0) {
    harness.runtime().restoreCpuState({
      ...harness.captureCpuState(),
      pc: bios.labels[label],
      sp: label === "WARMBOOT" ? bios.labels.BOOTSP : 0xd000,
      b: bc >>> 8,
      c: bc & 255,
      d: 0x12,
      e: 1,
      ix: 0x2345,
      iy: 0x3456,
      halted: false,
    });
  }
  function allocationUnchanged() {
    assert.deepEqual(
      memory.slice(profile.allocationBase),
      new Uint8Array(profile.allocationBytes).fill(0xa6),
    );
  }
  function call(label, bc = 0) {
    memory.set([0, 2], 0xd000);
    enter(label, bc);
    const state = runTo(0x200, 4096);
    assert.equal(state.pc, 0x200, label);
    assert.equal(state.sp, 0xd002, label);
    assert.equal(state.halted, false, label);
    allocationUnchanged();
    return state;
  }
  function dirtyRecord(drive, record, byte) {
    const io = machine.z80.hardware.ioWrite;
    io(0x11, drive);
    for (let i = 0; i < 4; i++) io(0x12 + i, (record >>> (8 * i)) & 255);
    io(0x10, 2);
    for (let i = 0; i < 128; i++) io(0x16, byte);
    assert.equal(machine.disk.snapshot().cacheDirty, true);
  }
  return {
    profile,
    bios,
    images,
    harness,
    machine,
    memory,
    commands,
    writes,
    runTo,
    enter,
    call,
    allocationUnchanged,
    dirtyRecord,
  };
}

describe("two-MiB machine profile assembly and interface", () => {
  it.each([undefined, null, "2", 0, -1, 17, 1.5, NaN, Infinity])(
    "rejects invalid configured count %s before source preparation",
    async (count) => {
      expect(() => twoMibResidentProfile(count)).toThrow(
        /integer from 1 to 16/,
      );
      await expect(prepareTwoMibSources(count)).rejects.toThrow(
        /integer from 1 to 16/,
      );
    },
  );

  it.each(COUNTS)(
    "assembles count %i with exact geometry and disjoint bounded storage",
    (count) => {
      const {
        profile: p,
        bios,
        bootstrap,
        biosSource,
        bootstrapSource,
      } = builds.get(count);
      expect(p.id).toBe(
        `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
      );
      expect(Object.isFrozen(p)).toBe(true);
      expect(Object.isFrozen(p.allocationSlots)).toBe(true);
      expect(p.allocationSlots.every(Object.isFrozen)).toBe(true);
      expect(p.allocationBase).toBe(65536 - 256 * Math.ceil(count / 2));
      expect(p.bios).toBe(p.allocationBase - 1024);
      expect(p.bdos).toBe(p.bios - 3584);
      expect(p.ccp).toBe(p.bdos - 2048);
      expect(p.comBytes).toBe(p.ccp - 256);
      expect(p.oddTailBytes).toBe(count % 2 ? 128 : 0);
      expect(bios.base).toBe(p.bios);
      expect(bios.bytes.length).toBe(1024);
      expect(bootstrap.base).toBe(0);
      expect(bootstrap.bytes.length).toBe(256);
      expect(bios.labels.COMMONND - p.bios).toBe(723);
      expect(bios.labels.COMMONND).toBeLessThanOrEqual(p.commonLimit);
      expect(bios.labels.DPHEADS).toBe(p.bios + 768);
      expect(bios.labels.DPHEND).toBe(p.dphBase + 16 * count);
      expect(bios.labels.DIRBUF + 128).toBe(bios.labels.BOOTSP - 32);
      expect(bootstrap.labels.STUBEND).toBe(124);
      const word = (address) =>
        bios.bytes[address - bios.base] |
        (bios.bytes[address - bios.base + 1] << 8);
      for (const slot of p.allocationSlots) {
        const dph = bios.labels[`DPH${slot.drive}`];
        expect(dph).toBe(p.dphBase + 16 * slot.drive);
        expect(word(dph + 8)).toBe(bios.labels.DIRBUF);
        expect(word(dph + 10)).toBe(bios.labels.DPBLOCK);
        expect(word(dph + 14)).toBe(slot.start);
        expect(slot.end - slot.start).toBe(127);
        expect(slot.guard).toBe(slot.end);
      }
      expect([
        ...bios.bytes.slice(
          bios.labels.DPBLOCK - p.bios,
          bios.labels.DPBLOCK - p.bios + 15,
        ),
      ]).toEqual([128, 0, 4, 15, 0, 247, 3, 255, 3, 255, 255, 0, 0, 1, 0]);
      expect(bios.bytes.slice(bios.labels.COMMONND - p.bios, 768)).toEqual(
        new Uint8Array(45),
      );
      expect(bios.bytes.slice(768 + 16 * count)).toEqual(
        new Uint8Array(256 - 16 * count),
      );
      expect(biosSource).toContain(
        `DRIVES EQU $${count.toString(16).toUpperCase()}`,
      );
      expect(bootstrapSource).toContain(
        `SYSBASE EQU $${p.ccp.toString(16).toUpperCase()}`,
      );
    },
  );

  it("leaves original one-drive and A/B source artifacts unchanged", async () => {
    const paths = ["system/cpm/bios.asm", "system/cpm/bios-8m-ab.asm"];
    const expected = [
      "8bb107b756a4794e0f9f7856f42bd236f2d9c8b9380a515eb2dc12a9b55f3414",
      "316f56f30c19416f6229fd760bacc8cad3baab65c6b15f8e856b175ce4c44907",
    ];
    for (let i = 0; i < paths.length; i++)
      expect(digest((await assembleAtomFile(paths[i])).bytes)).toBe(
        expected[i],
      );
    const again = await assembleTwoMibProfile(16);
    expect(again.bios.bytes).toEqual(builds.get(16).bios.bytes);
    expect(again.bootstrap.bytes).toEqual(builds.get(16).bootstrap.bytes);
  });

  it.each(COUNTS)(
    "selects all %i DPHs and isolates exact record boundaries",
    (count) => {
      const f = fixture(count);
      for (let drive = 0; drive < count; drive++) {
        const state = f.call("SELDSK", drive);
        assert.equal(state.h * 256 + state.l, f.bios.labels[`DPH${drive}`]);
        assert.deepEqual(
          [state.b, state.c, state.d, state.e, state.ix, state.iy],
          [0, drive, 0x12, 1, 0x2345, 0x3456],
        );
        assert.deepEqual(
          [0x12, 0x13, 0x14, 0x15].map((p) => f.machine.disk.readPort(p)),
          [0, 0x40, 0, 0],
        );
        for (const record of [0, 127, 128, 255, 256, 16382, 16383]) {
          f.call("SETTRACK", Math.floor(record / 128));
          f.call("SETSEC", (record % 128) + 1);
          f.call("SETDMA", 0x4000);
          f.commands.length = 0;
          assert.equal(f.call("READSEC").a, 0);
          assert.deepEqual(f.commands, [[drive, 1, record]]);
          assert.deepEqual(
            f.memory.slice(0x4000, 0x4080),
            f.images[drive].slice(record * 128, record * 128 + 128),
          );
          f.memory.fill(0x80 + drive, 0x4000, 0x4080);
          f.commands.length = 0;
          assert.equal(f.call("WRITESEC").a, 0);
          assert.deepEqual(f.commands, [
            [drive, 2, record],
            [drive, 3, record],
          ]);
          f.images[drive].fill(0x80 + drive, record * 128, record * 128 + 128);
        }
      }
      assert.deepEqual(f.machine.disk.exportPersistentImages(), f.images);
      for (const drive of [count, 16, 255]) {
        f.writes.length = 0;
        const state = f.call("SELDSK", drive);
        assert.equal(state.h * 256 + state.l, 0);
        assert.deepEqual(f.writes, []);
        assert.equal(f.memory[f.bios.labels.CURDRIVE], count - 1);
      }
    },
  );

  it.each(COUNTS)(
    "rejects invalid coordinates before I/O with %i slots",
    (count) => {
      const f = fixture(count);
      f.writes.length = 0;
      assert.equal(f.call("READSEC").a, 1);
      assert.deepEqual(f.writes, []);
      f.call("SELDSK", count - 1);
      for (const [track, sector] of [
        [128, 1],
        [256, 1],
        [65535, 128],
        [0, 0],
        [0, 129],
        [0, 256],
      ]) {
        f.call("SETTRACK", track);
        f.call("SETSEC", sector);
        f.writes.length = 0;
        assert.equal(f.call("READSEC").a, 1);
        assert.equal(f.call("WRITESEC").a, 1);
        assert.deepEqual(f.writes, []);
      }
    },
  );

  it.each([0, 512, SIZE - 512, SIZE + 512])(
    "rejects absent or %i-byte B and retains A binding for the next I/O",
    (length) => {
      const images = length
        ? [imageFor(0), imageFor(1, length)]
        : [imageFor(0)];
      const f = fixture(2, { images });
      f.call("SELDSK", 0);
      const rejected = f.call("SELDSK", 1);
      assert.equal(rejected.h * 256 + rejected.l, 0);
      assert.equal(f.memory[f.bios.labels.CURDRIVE], 0);
      f.call("SETDMA", 0x4000);
      f.call("SETTRACK", 1);
      f.call("SETSEC", 4);
      f.commands.length = 0;
      assert.equal(f.call("READSEC").a, 0);
      assert.deepEqual(f.commands, [[0, 1, 131]]);
      assert.deepEqual(
        f.memory.slice(0x4000, 0x4080),
        images[0].slice(131 * 128, 132 * 128),
      );
      assert.deepEqual(f.machine.disk.exportPersistentImages(), images);
    },
  );

  it.each([
    [1, 0x40, 0, 0],
    [0, 0x41, 0, 0],
    [0, 0x40, 1, 0],
    [0, 0x40, 0, 1],
  ])("validates every byte of the controller capacity %j", (...bytes) => {
    const f = fixture(1, { capacityBytes: bytes });
    const state = f.call("SELDSK", 0);
    assert.equal(state.h * 256 + state.l, 0);
    assert.equal(f.memory[f.bios.labels.CURDRIVE], 255);
    assert.deepEqual(
      f.commands.map((c) => c[1]),
      [4],
    );
  });

  it.each(COUNTS)(
    "cold-loads exact system bytes and warm-reloads only CCP/BDOS with %i slots",
    (count) => {
      const cold = fixture(count, { cold: true });
      const initial = cold.images[0].slice(0, 52 * 128);
      const loaded = cold.runTo(cold.profile.bios);
      assert.equal(loaded.pc, cold.profile.bios);
      assert.deepEqual(
        cold.memory.slice(cold.profile.ccp, cold.profile.end),
        initial,
      );
      const state = cold.runTo(cold.profile.ccp);
      assert.equal(state.pc, cold.profile.ccp);
      assert.equal(state.c, 0);
      assert.equal(state.sp, cold.bios.labels.BOOTSP);
      assert.deepEqual(
        cold.commands,
        Array.from({ length: 52 }, (_, r) => [0, 1, r]),
      );
      // The complete loaded image was compared before ColdBoot used its stack.
      assert(cold.writes.some(([p, v]) => p === 0x20 && v === 0xa5));
      assert.equal(cold.memory[cold.profile.bootstrapRecord], 52);
      assert.equal(cold.memory[cold.profile.bootstrapRemaining], 0);
      cold.allocationUnchanged();

      const f = fixture(count);
      f.memory[4] = count - 1;
      f.memory.fill(0x59, f.profile.ccp, f.profile.bios);
      const biosBefore = f.memory.slice(f.profile.bios, f.profile.end);
      f.commands.length = 0;
      f.enter("WARMBOOT");
      const warm = f.runTo(f.profile.ccp);
      assert.equal(warm.pc, f.profile.ccp);
      assert.equal(warm.c, count - 1);
      assert.equal(warm.sp, f.bios.labels.BOOTSP);
      assert.equal(warm.minSp, f.bios.labels.BOOTSP - 4);
      assert.deepEqual(
        f.memory.slice(f.profile.ccp, f.profile.bios),
        f.images[0].slice(0, 44 * 128),
      );
      assert.deepEqual(
        f.commands.filter(([, c]) => c === 3).map(([d]) => d),
        COUNTS.slice(0, count).map((v) => v - 1),
      );
      const firstRead = f.commands.findIndex(([, c]) => c === 1);
      assert.deepEqual(
        f.commands.slice(firstRead),
        Array.from({ length: 44 }, (_, r) => [0, 1, r]),
      );
      const codeBytes = f.bios.labels.BOOTREC - f.profile.bios;
      assert.deepEqual(
        f.memory.slice(f.profile.bios, f.bios.labels.BOOTREC),
        biosBefore.slice(0, codeBytes),
      );
      assert.deepEqual(
        f.memory.slice(f.bios.labels.DPHEADS, f.profile.end),
        biosBefore.slice(768),
      );
      assert.deepEqual(
        [...f.memory.slice(5, 8)],
        [0xc3, f.profile.bdosEntry & 255, f.profile.bdosEntry >>> 8],
      );
      f.allocationUnchanged();
    },
  );

  it.each([1, 2, 4, 16])(
    "flushes present wrong-size optional media, skips absence, and drains a real dirty cache for %i slots",
    (count) => {
      for (const present of [1, count]) {
        const images = Array.from({ length: present }, (_, i) =>
          imageFor(i, i === count - 1 && i !== 0 ? 512 : SIZE),
        );
        const f = fixture(count, { images });
        const dirty = present - 1;
        f.dirtyRecord(dirty, 2, 0xb7);
        assert.deepEqual(f.machine.disk.exportPersistentImages(), images);
        f.commands.length = 0;
        f.enter("WARMBOOT");
        assert.equal(f.runTo(f.profile.ccp).pc, f.profile.ccp);
        images[dirty].fill(0xb7, 256, 384);
        assert.deepEqual(f.machine.disk.exportPersistentImages(), images);
        assert.equal(f.machine.disk.snapshot().cacheDirty, false);
        assert.deepEqual(
          f.commands.filter(([, c]) => c === 3).map(([d]) => d),
          Array.from({ length: present }, (_, i) => i),
        );
      }
    },
  );

  it.each([0, 7, 15])(
    "halts before reload on configured drive %i flush failure, with explicit earlier-cache-drain behavior",
    (failFlush) => {
      const f = fixture(16, { failFlush });
      f.dirtyRecord(15, 63, 0xad);
      const before = f.images.map((image) => image.slice());
      f.memory.fill(0x59, f.profile.ccp, f.profile.bios);
      f.commands.length = 0;
      f.enter("WARMBOOT");
      assert.equal(f.runTo(f.profile.ccp).halted, true);
      assert.deepEqual(f.commands.at(-1).slice(0, 2), [failFlush, 3]);
      assert.equal(
        f.commands.some(([, c]) => c === 1),
        false,
      );
      assert.deepEqual(
        f.memory.slice(f.profile.ccp, f.profile.bios),
        new Uint8Array(44 * 128).fill(0x59),
      );
      if (failFlush !== 0) before[15].fill(0xad, 63 * 128, 64 * 128);
      assert.deepEqual(f.machine.disk.exportPersistentImages(), before);
      assert.equal(f.machine.disk.snapshot().cacheDirty, failFlush === 0);
      f.allocationUnchanged();
    },
  );

  it.each([0, 22, 43])(
    "halts on warm resident read failure at record %i without issuing later reads",
    (failRead) => {
      const f = fixture(4, { failRead });
      f.memory.fill(0x59, f.profile.ccp, f.profile.bios);
      f.enter("WARMBOOT");
      assert.equal(f.runTo(f.profile.ccp).halted, true);
      assert.deepEqual(
        f.commands.filter(([, c]) => c === 1),
        Array.from({ length: failRead + 1 }, (_, r) => [0, 1, r]),
      );
      assert.deepEqual(
        f.memory.slice(f.profile.ccp, f.profile.ccp + failRead * 128),
        f.images[0].slice(0, failRead * 128),
      );
      assert.deepEqual(
        f.memory.slice(f.profile.ccp + failRead * 128, f.profile.bios),
        new Uint8Array((44 - failRead) * 128).fill(0x59),
      );
      f.allocationUnchanged();
    },
  );

  it("rejects incompatible mandatory A before flushing or reloading", () => {
    const f = fixture(4, { images: [imageFor(0, 512), imageFor(1)] });
    f.memory.fill(0x59, f.profile.ccp, f.profile.bios);
    f.enter("WARMBOOT");
    assert.equal(f.runTo(f.profile.ccp).halted, true);
    assert.deepEqual(
      f.commands.map(([d, c]) => [d, c]),
      [[0, 4]],
    );
    assert.deepEqual(
      f.memory.slice(f.profile.ccp, f.profile.bios),
      new Uint8Array(44 * 128).fill(0x59),
    );
  });
});
