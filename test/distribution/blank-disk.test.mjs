import { describe, expect, it } from "vitest";

import {
  CPM22_BACKING_BYTES,
  CPM22_BACKING_SECTOR_BYTES,
  CPM22_LOGICAL_BYTES,
  CPM22_LOGICAL_RECORDS,
  createBlankCpm22Disk,
  installCpm22File,
  readCpm22File,
} from "../../tools/lib/cpm22-disk.mjs";

describe("fresh IBM-3740 disk", () => {
  it("has exact logical geometry, erased directory, and zero backing padding", () => {
    const disk = createBlankCpm22Disk();

    expect(CPM22_LOGICAL_RECORDS).toBe(77 * 26);
    expect(CPM22_LOGICAL_BYTES).toBe(256256);
    expect(CPM22_BACKING_SECTOR_BYTES).toBe(512);
    expect(CPM22_BACKING_BYTES).toBe(256512);
    expect(disk).toBeInstanceOf(Uint8Array);
    expect(disk).toHaveLength(256512);
    expect(disk.length % 512).toBe(0);
    expect(disk.slice(0, 6656)).toEqual(new Uint8Array(6656));
    expect(disk.slice(6656, 8704)).toEqual(new Uint8Array(2048).fill(0xe5));
    expect(disk.slice(8704, 256256)).toEqual(new Uint8Array(247552));
    expect(disk.slice(256256)).toEqual(new Uint8Array(256));
    expect(() => readCpm22File(disk, "ABSENT.TXT")).toThrow(/absent/);
  });

  it("returns deterministic, independently owned storage", () => {
    const first = createBlankCpm22Disk();
    const second = createBlankCpm22Disk();
    expect(first).toEqual(second);
    expect(first.buffer).not.toBe(second.buffer);

    first[0] = 0x11;
    first[6656] = 0;
    first[256511] = 0x22;
    expect(second).toEqual(createBlankCpm22Disk());
  });

  it("installs and reads empty and multi-extent files without mutating inputs", () => {
    const blank = createBlankCpm22Disk();
    const blankBefore = blank.slice();
    const empty = new Uint8Array();
    const withEmpty = installCpm22File(blank, {
      name: "EMPTY.TXT",
      bytes: empty,
    });
    const withEmptyBefore = withEmpty.slice();
    // Cross two complete 16 KiB extents and end on a partial record.
    const content = Uint8Array.from(
      { length: 32769 },
      (_, index) => (index * 37 + Math.floor(index / 128)) & 0xff,
    );
    const contentBefore = content.slice();
    const installed = installCpm22File(withEmpty, {
      name: "LARGE.BIN",
      bytes: content,
      padByte: 0xa7,
    });
    const installedBefore = installed.slice();
    const expectedRecords = new Uint8Array(32896).fill(0xa7);
    expectedRecords.set(content);

    expect(readCpm22File(withEmpty, "EMPTY.TXT")).toEqual(empty);
    expect(readCpm22File(installed, "EMPTY.TXT")).toEqual(empty);
    const read = readCpm22File(installed, "LARGE.BIN");
    expect(read).toEqual(expectedRecords);
    read.fill(0);
    expect(installed).toEqual(installedBefore);
    expect(blank).toEqual(blankBefore);
    expect(withEmpty).toEqual(withEmptyBefore);
    expect(content).toEqual(contentBefore);
    expect(installed).toHaveLength(256512);
    expect(installed.slice(0, 6656)).toEqual(new Uint8Array(6656));
    expect(installed.slice(256256)).toEqual(new Uint8Array(256));
  });
});
