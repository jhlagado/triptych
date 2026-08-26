import { describe, expect, it } from "vitest";
import {
  ESP32_SBC_BACKING_SECTOR_BYTES,
  ESP32_SBC_BOOT_ROM_BYTES,
  ESP32_SBC_DISK_COMMAND_FLUSH,
  ESP32_SBC_DISK_COMMAND_READ_RECORD,
  ESP32_SBC_DISK_COMMAND_WRITE_RECORD,
  ESP32_SBC_DISK_DATA_PORT,
  ESP32_SBC_DISK_DRIVE_PORT,
  ESP32_SBC_DISK_RECORD_0_PORT,
  ESP32_SBC_DISK_RECORD_1_PORT,
  ESP32_SBC_DISK_RECORD_2_PORT,
  ESP32_SBC_DISK_RECORD_3_PORT,
  ESP32_SBC_SERIAL_DATA_PORT,
  ESP32_SBC_SERIAL_STATUS_PORT,
  ESP32_SBC_SOUND_PORT_FIRST,
  ESP32_SBC_SOUND_PORT_LAST,
  ESP32_SBC_SYSTEM_CONTROL_PORT,
  ESP32_SBC_VDP_PORT_FIRST,
  ESP32_SBC_VDP_PORT_LAST,
} from "../../src/cpu/constants.js";
import { createEsp32SbcRuntime } from "../../src/cpu/runtime.js";
import { createDebug80TestRuntime } from "../support/debug80-runtime.js";

function bootRom(): Uint8Array {
  const rom = new Uint8Array(ESP32_SBC_BOOT_ROM_BYTES);
  rom.set([
    0x31,
    0xfe,
    0xff, // LD SP,$FFFE
    0xaf, // XOR A
    0xd3,
    ESP32_SBC_DISK_DRIVE_PORT,
    0xd3,
    ESP32_SBC_DISK_RECORD_0_PORT,
    0xd3,
    ESP32_SBC_DISK_RECORD_1_PORT,
    0xd3,
    ESP32_SBC_DISK_RECORD_2_PORT,
    0xd3,
    ESP32_SBC_DISK_RECORD_3_PORT,
    0x3e,
    ESP32_SBC_DISK_COMMAND_READ_RECORD,
    0xd3,
    0x10, // start record-zero read
    0x21,
    0x00,
    0x00, // LD HL,$0000
    0x06,
    0x80, // LD B,128
    0x0e,
    ESP32_SBC_DISK_DATA_PORT, // LD C,DISK_DATA
    0xed,
    0xb2, // INIR into RAM beneath the ROM overlay
    0x21,
    0x40,
    0x00, // LD HL,$0040 (disable stub in ROM)
    0x11,
    0x00,
    0xff, // LD DE,$FF00
    0x01,
    0x07,
    0x00, // LD BC,7
    0xed,
    0xb0, // LDIR
    0xc3,
    0x00,
    0xff, // JP $FF00
  ]);
  rom.set(
    [
      0x3e,
      0xa5, // LD A,$A5
      0xd3,
      ESP32_SBC_SYSTEM_CONTROL_PORT, // disable ROM
      0xc3,
      0x00,
      0x00, // JP $0000
    ],
    0x40,
  );
  return rom;
}

function loadedProgram(): Uint8Array {
  const record = new Uint8Array(128);
  record.set([
    0x3e,
    0x42,
    0xd3,
    ESP32_SBC_SERIAL_DATA_PORT, // print B
    0xaf,
    0xd3,
    ESP32_SBC_DISK_DRIVE_PORT,
    0x3e,
    0x01,
    0xd3,
    ESP32_SBC_DISK_RECORD_0_PORT,
    0xaf,
    0xd3,
    ESP32_SBC_DISK_RECORD_1_PORT,
    0xd3,
    ESP32_SBC_DISK_RECORD_2_PORT,
    0xd3,
    ESP32_SBC_DISK_RECORD_3_PORT,
    0x3e,
    ESP32_SBC_DISK_COMMAND_WRITE_RECORD,
    0xd3,
    0x10,
    0x06,
    0x80, // LD B,128
    0x3e,
    0x5a, // LD A,$5A
    0xd3,
    ESP32_SBC_DISK_DATA_PORT,
    0x10,
    0xfc, // DJNZ write byte
    0x3e,
    ESP32_SBC_DISK_COMMAND_FLUSH,
    0xd3,
    0x10,
    0x3e,
    0x50,
    0xd3,
    ESP32_SBC_SERIAL_DATA_PORT, // print P
    0x76, // HALT
  ]);
  return record;
}

describe("ESP32 SBC composed runtime", () => {
  it("executes ROM, loads RAM through disk ports, removes the overlay, and persists a write", () => {
    const image = new Uint8Array(ESP32_SBC_BACKING_SECTOR_BYTES);
    image.set(loadedProgram());
    image.fill(0x11, 128, 256);
    const machine = createEsp32SbcRuntime({
      bootRom: bootRom(),
      drives: [{ image }],
      createZ80Runtime: createDebug80TestRuntime,
    });

    for (
      let instruction = 0;
      instruction < 1000 && !machine.z80.isHalted();
      instruction += 1
    ) {
      machine.z80.step();
    }

    expect(machine.z80.isHalted()).toBe(true);
    expect(machine.memory.snapshot().bootRomEnabled).toBe(false);
    expect(machine.z80.hardware.memory[0]).toBe(0x3e);
    expect(machine.serial.drainOutput()).toEqual([0x42, 0x50]);
    expect(machine.disk.exportPersistentImages()[0]?.slice(128, 256)).toEqual(
      new Uint8Array(128).fill(0x5a),
    );

    const fresh = createEsp32SbcRuntime({
      bootRom: bootRom(),
      drives: [{ image: machine.disk.exportPersistentImages()[0] ?? image }],
      createZ80Runtime: createDebug80TestRuntime,
    });
    expect(fresh.disk.exportPersistentImages()[0]?.slice(128, 256)).toEqual(
      new Uint8Array(128).fill(0x5a),
    );
  });

  it("decodes low port bytes and requires the exact overlay-disable key", () => {
    const machine = createEsp32SbcRuntime({
      bootRom: bootRom(),
      drives: [{ image: new Uint8Array(ESP32_SBC_BACKING_SECTOR_BYTES) }],
      createZ80Runtime: createDebug80TestRuntime,
    });

    machine.z80.hardware.ioWrite(0xab00 | ESP32_SBC_SERIAL_DATA_PORT, 0x41);
    machine.serial.enqueueInput([0x42]);
    expect(
      machine.z80.hardware.ioRead(0xcd00 | ESP32_SBC_SERIAL_STATUS_PORT),
    ).toBe(0x03);
    expect(
      machine.z80.hardware.ioRead(0xef00 | ESP32_SBC_SERIAL_DATA_PORT),
    ).toBe(0x42);
    expect(machine.serial.drainOutput()).toEqual([0x41]);

    machine.z80.hardware.ioWrite(ESP32_SBC_SYSTEM_CONTROL_PORT, 0xa4);
    expect(machine.memory.snapshot().bootRomEnabled).toBe(true);
    machine.z80.hardware.ioWrite(ESP32_SBC_SYSTEM_CONTROL_PORT, 0xa5);
    expect(machine.memory.snapshot().bootRomEnabled).toBe(false);
    machine.reset();
    expect(machine.memory.snapshot().bootRomEnabled).toBe(true);
  });

  it("routes the complete VDP and sound windows through independent transports", () => {
    const vdpWrites: Array<[number, number]> = [];
    const soundWrites: Array<[number, number]> = [];
    let vdpResets = 0;
    let soundResets = 0;
    const machine = createEsp32SbcRuntime({
      bootRom: bootRom(),
      drives: [{ image: new Uint8Array(ESP32_SBC_BACKING_SECTOR_BYTES) }],
      createZ80Runtime: createDebug80TestRuntime,
      vdpTransport: {
        readPort: (offset) => 0x80 | offset,
        writePort: (offset, value) => vdpWrites.push([offset, value]),
        reset: () => {
          vdpResets += 1;
        },
      },
      soundTransport: {
        readPort: (offset) => 0x40 | offset,
        writePort: (offset, value) => soundWrites.push([offset, value]),
        reset: () => {
          soundResets += 1;
        },
      },
    });

    expect([ESP32_SBC_VDP_PORT_FIRST, ESP32_SBC_VDP_PORT_LAST]).toEqual([
      0x40, 0x4f,
    ]);
    expect([ESP32_SBC_SOUND_PORT_FIRST, ESP32_SBC_SOUND_PORT_LAST]).toEqual([
      0x50, 0x57,
    ]);

    machine.z80.hardware.ioWrite(0xab00 | ESP32_SBC_VDP_PORT_FIRST, 0x123);
    machine.z80.hardware.ioWrite(0xcd00 | ESP32_SBC_VDP_PORT_LAST, 0x45);
    machine.z80.hardware.ioWrite(ESP32_SBC_SOUND_PORT_FIRST, 0x67);
    machine.z80.hardware.ioWrite(ESP32_SBC_SOUND_PORT_LAST, 0x89);

    expect(vdpWrites).toEqual([
      [0, 0x23],
      [15, 0x45],
    ]);
    expect(soundWrites).toEqual([
      [0, 0x67],
      [7, 0x89],
    ]);
    expect(machine.z80.hardware.ioRead(0xef00 | ESP32_SBC_VDP_PORT_LAST)).toBe(
      0x8f,
    );
    expect(machine.z80.hardware.ioRead(ESP32_SBC_SOUND_PORT_LAST)).toBe(0x47);

    machine.reset();
    expect(vdpResets).toBe(1);
    expect(soundResets).toBe(1);
  });
});
