/** Cached 128-byte logical-record controller for the ESP32 SBC profile. */

import {
  ESP32_SBC_BACKING_SECTOR_BYTES,
  ESP32_SBC_DISK_COMMAND_FLUSH,
  ESP32_SBC_DISK_COMMAND_GET_CAPACITY,
  ESP32_SBC_DISK_COMMAND_READ_RECORD,
  ESP32_SBC_DISK_COMMAND_STATUS_PORT,
  ESP32_SBC_DISK_COMMAND_WRITE_RECORD,
  ESP32_SBC_DISK_DATA_PORT,
  ESP32_SBC_DISK_DRIVE_PORT,
  ESP32_SBC_DISK_ERROR_COMMAND,
  ESP32_SBC_DISK_ERROR_DRIVE,
  ESP32_SBC_DISK_ERROR_NONE,
  ESP32_SBC_DISK_ERROR_PORT,
  ESP32_SBC_DISK_ERROR_PROTOCOL,
  ESP32_SBC_DISK_ERROR_RECORD,
  ESP32_SBC_DISK_ERROR_WRITE_PROTECTED,
  ESP32_SBC_DISK_RECORD_0_PORT,
  ESP32_SBC_DISK_RECORD_1_PORT,
  ESP32_SBC_DISK_RECORD_2_PORT,
  ESP32_SBC_DISK_RECORD_3_PORT,
  ESP32_SBC_DISK_STATUS_DATA_REQUEST,
  ESP32_SBC_DISK_STATUS_DIRTY,
  ESP32_SBC_DISK_STATUS_ERROR,
  ESP32_SBC_DISK_STATUS_MEDIA_PRESENT,
  ESP32_SBC_DISK_STATUS_READY,
  ESP32_SBC_DISK_STATUS_WRITE_PROTECTED,
  ESP32_SBC_GUEST_RECORD_BYTES,
  ESP32_SBC_RECORDS_PER_BACKING_SECTOR,
} from "./constants.js";

export interface Esp32SbcDiskImage {
  image: Uint8Array;
  writable?: boolean;
}

export interface Esp32SbcBlockDeviceOptions {
  drives: readonly Esp32SbcDiskImage[];
}

export interface Esp32SbcBlockDeviceSnapshot {
  drive: number;
  record: number;
  status: number;
  error: number;
  transferKind?: "read" | "write";
  transferPosition?: number;
  cacheDrive?: number;
  cacheSector?: number;
  cacheDirty: boolean;
}

export interface Esp32SbcBlockDevice {
  readPort(port: number): number;
  writePort(port: number, value: number): void;
  reset(): void;
  exportPersistentImages(): Uint8Array[];
  snapshot(): Esp32SbcBlockDeviceSnapshot;
}

interface DriveState {
  persistent: Uint8Array;
  writable: boolean;
}

interface CacheState {
  drive: number;
  sector: number;
  bytes: Uint8Array;
  dirty: boolean;
}

interface TransferState {
  kind: "read" | "write";
  position: number;
  recordOffset: number;
  bytes: Uint8Array;
}

export function createEsp32SbcBlockDevice(
  options: Esp32SbcBlockDeviceOptions,
): Esp32SbcBlockDevice {
  const drives: DriveState[] = options.drives.map((drive, index) => {
    if (
      drive.image.length === 0 ||
      drive.image.length % ESP32_SBC_BACKING_SECTOR_BYTES !== 0
    ) {
      throw new RangeError(
        `ESP32 SBC drive ${index} must contain a non-empty whole number of 512-byte sectors`,
      );
    }
    const capacity = drive.image.length / ESP32_SBC_GUEST_RECORD_BYTES;
    if (capacity > 0xffffffff) {
      throw new RangeError(
        `ESP32 SBC drive ${index} exceeds the 32-bit record address space`,
      );
    }
    return {
      persistent: drive.image.slice(),
      writable: drive.writable ?? true,
    };
  });

  let selectedDrive = 0;
  let selectedRecord = 0;
  let error = ESP32_SBC_DISK_ERROR_NONE;
  let cache: CacheState | undefined;
  let transfer: TransferState | undefined;

  const currentDrive = (): DriveState | undefined => drives[selectedDrive];

  const status = (): number => {
    const drive = currentDrive();
    return (
      ESP32_SBC_DISK_STATUS_READY |
      (transfer !== undefined ? ESP32_SBC_DISK_STATUS_DATA_REQUEST : 0) |
      (error !== ESP32_SBC_DISK_ERROR_NONE ? ESP32_SBC_DISK_STATUS_ERROR : 0) |
      (drive !== undefined ? ESP32_SBC_DISK_STATUS_MEDIA_PRESENT : 0) |
      (drive !== undefined && !drive.writable
        ? ESP32_SBC_DISK_STATUS_WRITE_PROTECTED
        : 0) |
      (cache?.dirty === true ? ESP32_SBC_DISK_STATUS_DIRTY : 0)
    );
  };

  const fail = (nextError: number): void => {
    transfer = undefined;
    error = nextError;
  };

  const validateSelection = (): DriveState | undefined => {
    const drive = currentDrive();
    if (drive === undefined) {
      fail(ESP32_SBC_DISK_ERROR_DRIVE);
      return undefined;
    }
    const capacity = drive.persistent.length / ESP32_SBC_GUEST_RECORD_BYTES;
    if (selectedRecord >= capacity) {
      fail(ESP32_SBC_DISK_ERROR_RECORD);
      return undefined;
    }
    return drive;
  };

  const flushCache = (): void => {
    if (cache === undefined || !cache.dirty) {
      return;
    }
    const drive = drives[cache.drive];
    if (drive === undefined || !drive.writable) {
      fail(
        drive === undefined
          ? ESP32_SBC_DISK_ERROR_DRIVE
          : ESP32_SBC_DISK_ERROR_WRITE_PROTECTED,
      );
      return;
    }
    drive.persistent.set(
      cache.bytes,
      cache.sector * ESP32_SBC_BACKING_SECTOR_BYTES,
    );
    cache.dirty = false;
  };

  const selectCache = (
    driveIndex: number,
    record: number,
  ): CacheState | undefined => {
    const sector = Math.floor(record / ESP32_SBC_RECORDS_PER_BACKING_SECTOR);
    if (cache?.drive === driveIndex && cache.sector === sector) {
      return cache;
    }
    flushCache();
    if (error !== ESP32_SBC_DISK_ERROR_NONE) {
      return undefined;
    }
    const drive = drives[driveIndex];
    if (drive === undefined) {
      fail(ESP32_SBC_DISK_ERROR_DRIVE);
      return undefined;
    }
    const offset = sector * ESP32_SBC_BACKING_SECTOR_BYTES;
    cache = {
      drive: driveIndex,
      sector,
      bytes: drive.persistent.slice(
        offset,
        offset + ESP32_SBC_BACKING_SECTOR_BYTES,
      ),
      dirty: false,
    };
    return cache;
  };

  const recordOffset = (): number =>
    (selectedRecord % ESP32_SBC_RECORDS_PER_BACKING_SECTOR) *
    ESP32_SBC_GUEST_RECORD_BYTES;

  const beginRead = (): void => {
    if (validateSelection() === undefined) {
      return;
    }
    error = ESP32_SBC_DISK_ERROR_NONE;
    const selectedCache = selectCache(selectedDrive, selectedRecord);
    if (selectedCache === undefined) {
      return;
    }
    const offset = recordOffset();
    transfer = {
      kind: "read",
      position: 0,
      recordOffset: offset,
      bytes: selectedCache.bytes.slice(
        offset,
        offset + ESP32_SBC_GUEST_RECORD_BYTES,
      ),
    };
  };

  const beginWrite = (): void => {
    const drive = validateSelection();
    if (drive === undefined) {
      return;
    }
    if (!drive.writable) {
      fail(ESP32_SBC_DISK_ERROR_WRITE_PROTECTED);
      return;
    }
    error = ESP32_SBC_DISK_ERROR_NONE;
    const selectedCache = selectCache(selectedDrive, selectedRecord);
    if (selectedCache === undefined) {
      return;
    }
    transfer = {
      kind: "write",
      position: 0,
      recordOffset: recordOffset(),
      bytes: new Uint8Array(ESP32_SBC_GUEST_RECORD_BYTES),
    };
  };

  const beginCommand = (command: number): void => {
    transfer = undefined;
    error = ESP32_SBC_DISK_ERROR_NONE;
    if (command === ESP32_SBC_DISK_COMMAND_READ_RECORD) {
      beginRead();
      return;
    }
    if (command === ESP32_SBC_DISK_COMMAND_WRITE_RECORD) {
      beginWrite();
      return;
    }
    if (command === ESP32_SBC_DISK_COMMAND_FLUSH) {
      flushCache();
      return;
    }
    if (command === ESP32_SBC_DISK_COMMAND_GET_CAPACITY) {
      const drive = currentDrive();
      if (drive === undefined) {
        fail(ESP32_SBC_DISK_ERROR_DRIVE);
        return;
      }
      selectedRecord =
        (drive.persistent.length / ESP32_SBC_GUEST_RECORD_BYTES) >>> 0;
      return;
    }
    fail(ESP32_SBC_DISK_ERROR_COMMAND);
  };

  const readData = (): number => {
    if (transfer?.kind !== "read") {
      fail(ESP32_SBC_DISK_ERROR_PROTOCOL);
      return 0;
    }
    const value = transfer.bytes[transfer.position] ?? 0;
    transfer.position += 1;
    if (transfer.position === ESP32_SBC_GUEST_RECORD_BYTES) {
      transfer = undefined;
    }
    return value;
  };

  const writeData = (value: number): void => {
    if (transfer?.kind !== "write") {
      fail(ESP32_SBC_DISK_ERROR_PROTOCOL);
      return;
    }
    transfer.bytes[transfer.position] = value & 0xff;
    transfer.position += 1;
    if (transfer.position !== ESP32_SBC_GUEST_RECORD_BYTES) {
      return;
    }
    if (cache === undefined) {
      fail(ESP32_SBC_DISK_ERROR_PROTOCOL);
      return;
    }
    cache.bytes.set(transfer.bytes, transfer.recordOffset);
    cache.dirty = true;
    transfer = undefined;
  };

  const updateSelection = (update: () => void): void => {
    if (transfer !== undefined) {
      fail(ESP32_SBC_DISK_ERROR_PROTOCOL);
    }
    update();
  };

  const readPort = (port: number): number => {
    switch (port & 0xff) {
      case ESP32_SBC_DISK_COMMAND_STATUS_PORT:
        return status();
      case ESP32_SBC_DISK_DRIVE_PORT:
        return selectedDrive;
      case ESP32_SBC_DISK_RECORD_0_PORT:
        return selectedRecord & 0xff;
      case ESP32_SBC_DISK_RECORD_1_PORT:
        return (selectedRecord >>> 8) & 0xff;
      case ESP32_SBC_DISK_RECORD_2_PORT:
        return (selectedRecord >>> 16) & 0xff;
      case ESP32_SBC_DISK_RECORD_3_PORT:
        return (selectedRecord >>> 24) & 0xff;
      case ESP32_SBC_DISK_DATA_PORT:
        return readData();
      case ESP32_SBC_DISK_ERROR_PORT:
        return error;
      default:
        return 0;
    }
  };

  const writePort = (port: number, value: number): void => {
    const byte = value & 0xff;
    switch (port & 0xff) {
      case ESP32_SBC_DISK_COMMAND_STATUS_PORT:
        beginCommand(byte);
        return;
      case ESP32_SBC_DISK_DRIVE_PORT:
        updateSelection(() => {
          selectedDrive = byte;
        });
        return;
      case ESP32_SBC_DISK_RECORD_0_PORT:
        updateSelection(() => {
          selectedRecord = ((selectedRecord & 0xffffff00) | byte) >>> 0;
        });
        return;
      case ESP32_SBC_DISK_RECORD_1_PORT:
        updateSelection(() => {
          selectedRecord = ((selectedRecord & 0xffff00ff) | (byte << 8)) >>> 0;
        });
        return;
      case ESP32_SBC_DISK_RECORD_2_PORT:
        updateSelection(() => {
          selectedRecord = ((selectedRecord & 0xff00ffff) | (byte << 16)) >>> 0;
        });
        return;
      case ESP32_SBC_DISK_RECORD_3_PORT:
        updateSelection(() => {
          selectedRecord = ((selectedRecord & 0x00ffffff) | (byte << 24)) >>> 0;
        });
        return;
      case ESP32_SBC_DISK_DATA_PORT:
        writeData(byte);
        return;
      default:
        return;
    }
  };

  const reset = (): void => {
    selectedDrive = 0;
    selectedRecord = 0;
    error = ESP32_SBC_DISK_ERROR_NONE;
    transfer = undefined;
  };

  const exportPersistentImages = (): Uint8Array[] =>
    drives.map((drive) => drive.persistent.slice());

  const snapshot = (): Esp32SbcBlockDeviceSnapshot => ({
    drive: selectedDrive,
    record: selectedRecord,
    status: status(),
    error,
    ...(transfer !== undefined
      ? { transferKind: transfer.kind, transferPosition: transfer.position }
      : {}),
    ...(cache !== undefined
      ? { cacheDrive: cache.drive, cacheSector: cache.sector }
      : {}),
    cacheDirty: cache?.dirty ?? false,
  });

  return { readPort, writePort, reset, exportPersistentImages, snapshot };
}
