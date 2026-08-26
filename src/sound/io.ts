/**
 * @file Adapter from a machine-selected Z80 port window to the sound device.
 */

import type { Z80IoHandlers } from "../shared/z80.js";
import { ESP32_SOUND_PORT_COUNT } from "./constants.js";
import type { Esp32SoundDevice, Esp32SoundIoWindow } from "./types.js";

/** Maps the logical eight-port interface at a caller-selected low-byte base. */
export function createEsp32SoundIoWindow(
  device: Esp32SoundDevice,
  basePort: number,
): Esp32SoundIoWindow {
  if (
    !Number.isInteger(basePort) ||
    basePort < 0 ||
    basePort > 0x100 - ESP32_SOUND_PORT_COUNT
  ) {
    throw new RangeError(
      "basePort must leave room for an eight-port low-byte window",
    );
  }
  const handlers: Z80IoHandlers = {
    read(port: number): number {
      const offset = (port & 0xff) - basePort;
      return offset >= 0 && offset < ESP32_SOUND_PORT_COUNT
        ? device.readPort(offset)
        : 0xff;
    },
    write(port: number, value: number): void {
      const offset = (port & 0xff) - basePort;
      if (offset >= 0 && offset < ESP32_SOUND_PORT_COUNT) {
        device.writePort(offset, value);
      }
    },
  };
  return { handlers, basePort };
}
