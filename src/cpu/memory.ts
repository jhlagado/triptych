/** Reset-controlled boot-ROM overlay over the ESP32 SBC's flat guest RAM. */

import { ESP32_SBC_BOOT_ROM_BYTES } from "./constants.js";

export interface Esp32SbcMemorySnapshot {
  bootRomEnabled: boolean;
}

export interface Esp32SbcMemory {
  read(address: number): number;
  write(address: number, value: number): void;
  disableBootRom(): void;
  reset(): void;
  snapshot(): Esp32SbcMemorySnapshot;
}

export interface Esp32SbcMemoryOptions {
  ram: Uint8Array;
  bootRom: Uint8Array;
}

export function createEsp32SbcMemory(
  options: Esp32SbcMemoryOptions,
): Esp32SbcMemory {
  if (options.ram.length !== 0x10000) {
    throw new RangeError(
      "ESP32 SBC guest RAM must contain exactly 65536 bytes",
    );
  }
  if (options.bootRom.length !== ESP32_SBC_BOOT_ROM_BYTES) {
    throw new RangeError(
      `ESP32 SBC boot ROM must contain exactly ${ESP32_SBC_BOOT_ROM_BYTES} bytes`,
    );
  }

  const bootRom = options.bootRom.slice();
  let bootRomEnabled = true;

  const read = (address: number): number => {
    const masked = address & 0xffff;
    if (bootRomEnabled && masked < bootRom.length) {
      return bootRom[masked] ?? 0;
    }
    return options.ram[masked] ?? 0;
  };

  const write = (address: number, value: number): void => {
    options.ram[address & 0xffff] = value & 0xff;
  };

  const disableBootRom = (): void => {
    bootRomEnabled = false;
  };

  const reset = (): void => {
    bootRomEnabled = true;
  };

  const snapshot = (): Esp32SbcMemorySnapshot => ({ bootRomEnabled });

  return { read, write, disableBootRom, reset, snapshot };
}
