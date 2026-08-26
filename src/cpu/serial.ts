/** Byte-oriented serial console below the ESP32 SBC guest BIOS. */

import {
  ESP32_SBC_SERIAL_STATUS_RX_READY,
  ESP32_SBC_SERIAL_STATUS_TX_READY,
} from "./constants.js";

export interface Esp32SbcSerialSnapshot {
  input: number[];
  output: number[];
}

export interface Esp32SbcSerial {
  enqueueInput(bytes: Iterable<number>): void;
  readData(): number;
  readStatus(): number;
  writeData(value: number): void;
  drainOutput(): number[];
  reset(): void;
  snapshot(): Esp32SbcSerialSnapshot;
}

export function createEsp32SbcSerial(): Esp32SbcSerial {
  const input: number[] = [];
  const output: number[] = [];

  const enqueueInput = (bytes: Iterable<number>): void => {
    for (const value of bytes) {
      input.push(value & 0xff);
    }
  };

  const readData = (): number => input.shift() ?? 0;

  const readStatus = (): number =>
    ESP32_SBC_SERIAL_STATUS_TX_READY |
    (input.length > 0 ? ESP32_SBC_SERIAL_STATUS_RX_READY : 0);

  const writeData = (value: number): void => {
    output.push(value & 0xff);
  };

  const drainOutput = (): number[] => output.splice(0, output.length);

  const reset = (): void => {
    input.length = 0;
    output.length = 0;
  };

  const snapshot = (): Esp32SbcSerialSnapshot => ({
    input: [...input],
    output: [...output],
  });

  return {
    enqueueInput,
    readData,
    readStatus,
    writeData,
    drainOutput,
    reset,
    snapshot,
  };
}
