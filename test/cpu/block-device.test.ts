import { describe, expect, it } from "vitest";
import {
  ESP32_SBC_BACKING_SECTOR_BYTES,
  ESP32_SBC_DISK_COMMAND_FLUSH,
  ESP32_SBC_DISK_COMMAND_GET_CAPACITY,
  ESP32_SBC_DISK_COMMAND_READ_RECORD,
  ESP32_SBC_DISK_COMMAND_STATUS_PORT,
  ESP32_SBC_DISK_COMMAND_WRITE_RECORD,
  ESP32_SBC_DISK_DATA_PORT,
  ESP32_SBC_DISK_DRIVE_PORT,
  ESP32_SBC_DISK_ERROR_PORT,
  ESP32_SBC_DISK_ERROR_PROTOCOL,
  ESP32_SBC_DISK_ERROR_RECORD,
  ESP32_SBC_DISK_RECORD_0_PORT,
  ESP32_SBC_DISK_RECORD_1_PORT,
  ESP32_SBC_DISK_RECORD_2_PORT,
  ESP32_SBC_DISK_RECORD_3_PORT,
  ESP32_SBC_DISK_STATUS_DATA_REQUEST,
  ESP32_SBC_DISK_STATUS_DIRTY,
  ESP32_SBC_DISK_STATUS_ERROR,
  ESP32_SBC_GUEST_RECORD_BYTES,
} from "../../src/cpu/constants.js";
import {
  createEsp32SbcBlockDevice,
  type Esp32SbcBlockDevice,
} from "../../src/cpu/block-device.js";

function selectRecord(device: Esp32SbcBlockDevice, record: number): void {
  device.writePort(ESP32_SBC_DISK_RECORD_0_PORT, record);
  device.writePort(ESP32_SBC_DISK_RECORD_1_PORT, record >>> 8);
  device.writePort(ESP32_SBC_DISK_RECORD_2_PORT, record >>> 16);
  device.writePort(ESP32_SBC_DISK_RECORD_3_PORT, record >>> 24);
}

function readRecord(device: Esp32SbcBlockDevice, record: number): Uint8Array {
  selectRecord(device, record);
  device.writePort(
    ESP32_SBC_DISK_COMMAND_STATUS_PORT,
    ESP32_SBC_DISK_COMMAND_READ_RECORD,
  );
  return Uint8Array.from({ length: ESP32_SBC_GUEST_RECORD_BYTES }, () =>
    device.readPort(ESP32_SBC_DISK_DATA_PORT),
  );
}

function writeRecord(
  device: Esp32SbcBlockDevice,
  record: number,
  bytes: Uint8Array,
): void {
  selectRecord(device, record);
  device.writePort(
    ESP32_SBC_DISK_COMMAND_STATUS_PORT,
    ESP32_SBC_DISK_COMMAND_WRITE_RECORD,
  );
  for (const byte of bytes) {
    device.writePort(ESP32_SBC_DISK_DATA_PORT, byte);
  }
}

describe("ESP32 SBC logical-record disk controller", () => {
  it("selects all four 128-byte quarters of a 512-byte backing sector", () => {
    const image = Uint8Array.from(
      { length: ESP32_SBC_BACKING_SECTOR_BYTES },
      (_, index) => Math.floor(index / ESP32_SBC_GUEST_RECORD_BYTES) + 1,
    );
    const device = createEsp32SbcBlockDevice({ drives: [{ image }] });

    for (let record = 0; record < 4; record += 1) {
      expect(readRecord(device, record)).toEqual(
        new Uint8Array(ESP32_SBC_GUEST_RECORD_BYTES).fill(record + 1),
      );
    }
  });

  it("publishes a complete write to cache, preserves neighbours, and persists only on flush", () => {
    const image = Uint8Array.from(
      { length: ESP32_SBC_BACKING_SECTOR_BYTES },
      (_, index) => index & 0xff,
    );
    const device = createEsp32SbcBlockDevice({ drives: [{ image }] });
    const replacement = new Uint8Array(ESP32_SBC_GUEST_RECORD_BYTES).fill(0x5a);

    writeRecord(device, 1, replacement);

    expect(device.snapshot().status & ESP32_SBC_DISK_STATUS_DIRTY).not.toBe(0);
    expect(readRecord(device, 1)).toEqual(replacement);
    expect(device.exportPersistentImages()[0]).toEqual(image);

    device.writePort(
      ESP32_SBC_DISK_COMMAND_STATUS_PORT,
      ESP32_SBC_DISK_COMMAND_FLUSH,
    );
    const persisted = device.exportPersistentImages()[0];
    expect(persisted?.slice(0, ESP32_SBC_GUEST_RECORD_BYTES)).toEqual(
      image.slice(0, ESP32_SBC_GUEST_RECORD_BYTES),
    );
    expect(
      persisted?.slice(
        ESP32_SBC_GUEST_RECORD_BYTES,
        2 * ESP32_SBC_GUEST_RECORD_BYTES,
      ),
    ).toEqual(replacement);
    expect(persisted?.slice(2 * ESP32_SBC_GUEST_RECORD_BYTES)).toEqual(
      image.slice(2 * ESP32_SBC_GUEST_RECORD_BYTES),
    );
  });

  it("flushes a dirty line before replacing it", () => {
    const image = new Uint8Array(2 * ESP32_SBC_BACKING_SECTOR_BYTES);
    const device = createEsp32SbcBlockDevice({ drives: [{ image }] });
    const replacement = new Uint8Array(ESP32_SBC_GUEST_RECORD_BYTES).fill(0xa5);

    writeRecord(device, 0, replacement);
    expect(readRecord(device, 4)).toEqual(
      new Uint8Array(ESP32_SBC_GUEST_RECORD_BYTES),
    );

    expect(
      device
        .exportPersistentImages()[0]
        ?.slice(0, ESP32_SBC_GUEST_RECORD_BYTES),
    ).toEqual(replacement);
  });

  it("aborts a partial write without changing cache or media", () => {
    const image = new Uint8Array(ESP32_SBC_BACKING_SECTOR_BYTES).fill(0x11);
    const device = createEsp32SbcBlockDevice({ drives: [{ image }] });
    selectRecord(device, 2);
    device.writePort(
      ESP32_SBC_DISK_COMMAND_STATUS_PORT,
      ESP32_SBC_DISK_COMMAND_WRITE_RECORD,
    );
    for (let index = 0; index < ESP32_SBC_GUEST_RECORD_BYTES - 1; index += 1) {
      device.writePort(ESP32_SBC_DISK_DATA_PORT, 0x22);
    }

    device.reset();

    expect(device.snapshot().transferKind).toBeUndefined();
    expect(device.snapshot().cacheDirty).toBe(false);
    expect(device.exportPersistentImages()[0]).toEqual(image);
  });

  it("reports capacity and rejects the first record beyond it without wraparound", () => {
    const image = new Uint8Array(2 * ESP32_SBC_BACKING_SECTOR_BYTES);
    const device = createEsp32SbcBlockDevice({ drives: [{ image }] });
    device.writePort(
      ESP32_SBC_DISK_COMMAND_STATUS_PORT,
      ESP32_SBC_DISK_COMMAND_GET_CAPACITY,
    );

    expect(device.snapshot().record).toBe(8);
    expect(readRecord(device, 7)).toHaveLength(ESP32_SBC_GUEST_RECORD_BYTES);
    selectRecord(device, 8);
    device.writePort(
      ESP32_SBC_DISK_COMMAND_STATUS_PORT,
      ESP32_SBC_DISK_COMMAND_READ_RECORD,
    );
    expect(device.readPort(ESP32_SBC_DISK_ERROR_PORT)).toBe(
      ESP32_SBC_DISK_ERROR_RECORD,
    );
    expect(
      device.readPort(ESP32_SBC_DISK_COMMAND_STATUS_PORT) &
        ESP32_SBC_DISK_STATUS_ERROR,
    ).not.toBe(0);
  });

  it("rejects data transfers in the wrong state and unavailable drives", () => {
    const device = createEsp32SbcBlockDevice({
      drives: [{ image: new Uint8Array(ESP32_SBC_BACKING_SECTOR_BYTES) }],
    });

    expect(device.readPort(ESP32_SBC_DISK_DATA_PORT)).toBe(0);
    expect(device.readPort(ESP32_SBC_DISK_ERROR_PORT)).toBe(
      ESP32_SBC_DISK_ERROR_PROTOCOL,
    );
    device.writePort(ESP32_SBC_DISK_DRIVE_PORT, 1);
    device.writePort(
      ESP32_SBC_DISK_COMMAND_STATUS_PORT,
      ESP32_SBC_DISK_COMMAND_READ_RECORD,
    );
    expect(device.snapshot().status & ESP32_SBC_DISK_STATUS_DATA_REQUEST).toBe(
      0,
    );
    expect(device.snapshot().status & ESP32_SBC_DISK_STATUS_ERROR).not.toBe(0);
  });
});
