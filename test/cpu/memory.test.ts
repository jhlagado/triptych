import { describe, expect, it } from "vitest";
import { ESP32_SBC_BOOT_ROM_BYTES } from "../../src/cpu/constants.js";
import { createEsp32SbcMemory } from "../../src/cpu/memory.js";

describe("ESP32 SBC boot-ROM overlay", () => {
  it("reads ROM while writing the underlying RAM and restores the overlay only on reset", () => {
    const ram = new Uint8Array(0x10000);
    const rom = new Uint8Array(ESP32_SBC_BOOT_ROM_BYTES);
    rom[0] = 0xa5;
    rom[0xff] = 0x5a;
    const memory = createEsp32SbcMemory({ ram, bootRom: rom });

    memory.write(0, 0x11);
    memory.write(0xff, 0x22);
    memory.write(0x100, 0x33);

    expect(memory.read(0)).toBe(0xa5);
    expect(memory.read(0xff)).toBe(0x5a);
    expect(memory.read(0x100)).toBe(0x33);
    expect(ram.slice(0, 0x101)).toEqual(
      Uint8Array.from([0x11, ...new Uint8Array(0xfe), 0x22, 0x33]),
    );

    memory.disableBootRom();
    expect(memory.read(0)).toBe(0x11);
    expect(memory.read(0xff)).toBe(0x22);

    memory.reset();
    expect(memory.read(0)).toBe(0xa5);
    expect(memory.read(0xff)).toBe(0x5a);
  });

  it("requires exact 64 KiB RAM and 256-byte ROM images", () => {
    expect(() =>
      createEsp32SbcMemory({
        ram: new Uint8Array(0xffff),
        bootRom: new Uint8Array(ESP32_SBC_BOOT_ROM_BYTES),
      }),
    ).toThrow(/65536/);
    expect(() =>
      createEsp32SbcMemory({
        ram: new Uint8Array(0x10000),
        bootRom: new Uint8Array(ESP32_SBC_BOOT_ROM_BYTES - 1),
      }),
    ).toThrow(/256/);
  });
});
