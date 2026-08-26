/** Composed host reference runtime for the Triptych CPU profile. */

import type {
  CreateZ80HostRuntime,
  Z80HostRuntime,
  Z80IoHandlers,
} from "../shared/z80.js";
import {
  createEsp32SbcBlockDevice,
  type Esp32SbcBlockDevice,
  type Esp32SbcDiskImage,
} from "./block-device.js";
import {
  ESP32_SBC_BOOT_ROM_DISABLE_KEY,
  ESP32_SBC_DISK_COMMAND_STATUS_PORT,
  ESP32_SBC_DISK_ERROR_PORT,
  ESP32_SBC_SERIAL_DATA_PORT,
  ESP32_SBC_SERIAL_STATUS_PORT,
  ESP32_SBC_SOUND_PORT_FIRST,
  ESP32_SBC_SOUND_PORT_LAST,
  ESP32_SBC_SYSTEM_CONTROL_PORT,
  ESP32_SBC_SYSTEM_STATUS_BOOT_ROM_ENABLED,
  ESP32_SBC_VDP_PORT_FIRST,
  ESP32_SBC_VDP_PORT_LAST,
} from "./constants.js";
import { createEsp32SbcMemory, type Esp32SbcMemory } from "./memory.js";
import { createEsp32SbcSerial, type Esp32SbcSerial } from "./serial.js";

export interface Esp32SbcRuntimeOptions {
  bootRom: Uint8Array;
  drives: readonly Esp32SbcDiskImage[];
  /** Creates the host-side Z80 engine used by tests and reference tools. */
  createZ80Runtime: CreateZ80HostRuntime;
  /** Synchronous logical-port transport; an ESP32 provider may implement this over SPI. */
  vdpTransport?: Esp32SbcPeripheralTransport;
  /** Synchronous logical-port transport; an ESP32 provider may implement this over SPI. */
  soundTransport?: Esp32SbcPeripheralTransport;
}

export interface Esp32SbcPeripheralTransport {
  readPort(offset: number): number;
  writePort(offset: number, value: number): void;
  reset?(): void;
}

export interface Esp32SbcRuntime {
  z80: Z80HostRuntime;
  memory: Esp32SbcMemory;
  serial: Esp32SbcSerial;
  disk: Esp32SbcBlockDevice;
  reset(): void;
}

export function createEsp32SbcRuntime(
  options: Esp32SbcRuntimeOptions,
): Esp32SbcRuntime {
  const serial = createEsp32SbcSerial();
  const disk = createEsp32SbcBlockDevice({ drives: options.drives });
  const state: { memory?: Esp32SbcMemory } = {};

  const ioHandlers: Z80IoHandlers = {
    read: (port: number): number => {
      const lowPort = port & 0xff;
      if (lowPort === ESP32_SBC_SERIAL_DATA_PORT) {
        return serial.readData();
      }
      if (lowPort === ESP32_SBC_SERIAL_STATUS_PORT) {
        return serial.readStatus();
      }
      if (
        lowPort >= ESP32_SBC_DISK_COMMAND_STATUS_PORT &&
        lowPort <= ESP32_SBC_DISK_ERROR_PORT
      ) {
        return disk.readPort(lowPort);
      }
      if (lowPort === ESP32_SBC_SYSTEM_CONTROL_PORT) {
        return state.memory?.snapshot().bootRomEnabled === true
          ? ESP32_SBC_SYSTEM_STATUS_BOOT_ROM_ENABLED
          : 0;
      }
      if (
        lowPort >= ESP32_SBC_VDP_PORT_FIRST &&
        lowPort <= ESP32_SBC_VDP_PORT_LAST
      ) {
        return (
          options.vdpTransport?.readPort(lowPort - ESP32_SBC_VDP_PORT_FIRST) ??
          0
        );
      }
      if (
        lowPort >= ESP32_SBC_SOUND_PORT_FIRST &&
        lowPort <= ESP32_SBC_SOUND_PORT_LAST
      ) {
        return (
          options.soundTransport?.readPort(
            lowPort - ESP32_SBC_SOUND_PORT_FIRST,
          ) ?? 0
        );
      }
      return 0;
    },
    write: (port: number, value: number): void => {
      const lowPort = port & 0xff;
      if (lowPort === ESP32_SBC_SERIAL_DATA_PORT) {
        serial.writeData(value);
        return;
      }
      if (
        lowPort >= ESP32_SBC_DISK_COMMAND_STATUS_PORT &&
        lowPort <= ESP32_SBC_DISK_ERROR_PORT
      ) {
        disk.writePort(lowPort, value);
        return;
      }
      if (
        lowPort === ESP32_SBC_SYSTEM_CONTROL_PORT &&
        (value & 0xff) === ESP32_SBC_BOOT_ROM_DISABLE_KEY
      ) {
        state.memory?.disableBootRom();
        return;
      }
      if (
        lowPort >= ESP32_SBC_VDP_PORT_FIRST &&
        lowPort <= ESP32_SBC_VDP_PORT_LAST
      ) {
        options.vdpTransport?.writePort(
          lowPort - ESP32_SBC_VDP_PORT_FIRST,
          value & 0xff,
        );
        return;
      }
      if (
        lowPort >= ESP32_SBC_SOUND_PORT_FIRST &&
        lowPort <= ESP32_SBC_SOUND_PORT_LAST
      ) {
        options.soundTransport?.writePort(
          lowPort - ESP32_SBC_SOUND_PORT_FIRST,
          value & 0xff,
        );
      }
    },
  };

  const z80 = options.createZ80Runtime(ioHandlers);
  const memory = createEsp32SbcMemory({
    ram: z80.hardware.memory,
    bootRom: options.bootRom,
  });
  state.memory = memory;
  z80.hardware.memRead = memory.read;
  z80.hardware.memWrite = memory.write;
  z80.hardware.forceMemWrite = memory.write;
  z80.hardware.isMemoryWritable = (): boolean => true;

  const reset = (): void => {
    memory.reset();
    serial.reset();
    disk.reset();
    options.vdpTransport?.reset?.();
    options.soundTransport?.reset?.();
    z80.reset();
  };

  return { z80, memory, serial, disk, reset };
}
