import { describe, expect, it } from "vitest";
import {
  BdosBiosDiskDouble,
  type BdosBiosDiskFixture,
} from "../support/bdos-bios-double.js";

const standardDisk: BdosBiosDiskFixture = {
  drives: [
    {
      number: 0,
      dphAddress: 0xfc00,
      directoryBufferAddress: 0xfc80,
      dpbAddress: 0xfc10,
      checkVectorAddress: 0xfd00,
      allocationVectorAddress: 0xfd20,
      firstSector: 1,
      defaultRecordByte: 0xe5,
      dpb: {
        sectorsPerTrack: 26,
        blockShift: 3,
        blockMask: 7,
        extentMask: 0,
        maximumBlock: 242,
        maximumDirectoryEntry: 63,
        directoryAllocation0: 0xc0,
        directoryAllocation1: 0,
        checkVectorBytes: 16,
        reservedTracks: 2,
      },
      records: [
        {
          record: 52,
          fill: 0,
          patches: [
            {
              offset: 1,
              bytes: Array.from({ length: 127 }, (_, index) => index + 1),
            },
          ],
        },
      ],
    },
  ],
};

function cpuState() {
  return { a: 0x99, b: 0, c: 0, d: 0, e: 0, h: 0, l: 0 };
}

describe("BDOS scripted BIOS disk double", () => {
  it("publishes the documented DPH and DPB layout", () => {
    const memory = new Uint8Array(0x10000).fill(0xaa);
    const bios = new BdosBiosDiskDouble(standardDisk, memory);

    expect([...memory.slice(0xfc00, 0xfc10)]).toEqual([
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x80, 0xfc, 0x10, 0xfc,
      0x00, 0xfd, 0x20, 0xfd,
    ]);
    expect([...memory.slice(0xfc10, 0xfc1f)]).toEqual([
      26, 0, 3, 7, 0, 242, 0, 63, 0, 0xc0, 0, 16, 0, 2, 0,
    ]);
    expect(bios.ownedWritableAddresses.size).toBe(181);
  });

  it("models select, positioning, wrapped DMA reads, writes, and translation", () => {
    const memory = new Uint8Array(0x10000);
    const bios = new BdosBiosDiskDouble(standardDisk, memory);
    let state = cpuState();
    bios.handle(9, state);
    expect([state.h, state.l]).toEqual([0xfc, 0x00]);

    state = { ...cpuState(), b: 0, c: 2 };
    bios.handle(10, state);
    state = { ...cpuState(), b: 0, c: 1 };
    bios.handle(11, state);
    state = { ...cpuState(), b: 0xff, c: 0xc0 };
    bios.handle(12, state);
    state = cpuState();
    bios.handle(13, state);
    expect(state.a).toBe(0);
    expect(bios.memoryWrittenAddresses.size).toBe(128);
    expect([...memory.slice(0xffc0)]).toEqual(
      Array.from({ length: 64 }, (_, index) => index),
    );
    expect([...memory.slice(0, 0x40)]).toEqual(
      Array.from({ length: 64 }, (_, index) => index + 64),
    );
    bios.beginCall();
    expect(bios.memoryWrittenAddresses.size).toBe(0);

    state = { ...cpuState(), b: 0, c: 2 };
    bios.handle(11, state);
    memory.fill(0x5a, 0xffc0);
    memory.fill(0x5a, 0, 0x40);
    state = cpuState();
    bios.handle(14, state);
    expect(state.a).toBe(0);
    expect(bios.snapshot().writes).toEqual([
      { drive: 0, record: 53, bytes: new Array(128).fill(0x5a) },
    ]);

    state = { ...cpuState(), b: 0, c: 25 };
    bios.handle(16, state);
    expect([state.h, state.l]).toEqual([0, 26]);

    state = { ...cpuState(), c: 1 };
    bios.handle(9, state);
    expect([state.h, state.l]).toEqual([0, 0]);
  });
});
