import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { assembleAtomBinary, assembleAtomFile } from "./lib/assemble-atom.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require(
  resolve(repositoryRoot, "dist", "wasm", "triptych_host_wasm.js"),
);
const BACKING_SECTOR_BYTES = 512;
const SENTINEL = 0xa5;

function endsWith(output, suffix) {
  return Buffer.from(output).toString("latin1").endsWith(suffix);
}

function padForBackingSectors(image) {
  const length =
    Math.ceil(image.length / BACKING_SECTOR_BYTES) * BACKING_SECTOR_BYTES;
  const padded = new Uint8Array(length);
  padded.set(image);
  return padded;
}

const [bootRom, ccp, bdos, bios, sourceDisk] = await Promise.all([
  assembleAtomBinary(resolve(repositoryRoot, "roms", "cpu", "bootstrap.asm")),
  assembleAtomFile(resolve(repositoryRoot, "roms", "cpu", "ccp", "ccp.asm")),
  assembleAtomBinary(
    resolve(repositoryRoot, "roms", "cpu", "bdos", "bdos.asm"),
  ),
  assembleAtomBinary(resolve(repositoryRoot, "system", "cpm", "bios.asm")),
  readFile(resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img")),
]);
const { STKGUARD, STKGUEND, STKBASE, STKTOP } = ccp.labels;
assert.equal(ccp.bytes.length, 0x0800, "fixed CCP resident image");
assert.equal(STKGUEND - STKGUARD, 16, "CCP stack guard bytes");
assert.equal(STKBASE, STKGUEND, "guard immediately precedes stack");
assert.equal(STKTOP - STKBASE, 48, "CCP private stack bytes");

const disk = padForBackingSectors(sourceDisk);
disk.set(ccp.bytes, 0x0000);
disk.set(bdos, 0x0800);
disk.set(bios, 0x1600);

function runCase(testCase) {
  const machine = new TriptychCpu(bootRom);
  machine.install_drive(0, disk, true);
  let steps = 0;
  let tStates = 0;
  let minimumStackPointer = STKTOP;

  function step(measure) {
    tStates += machine.step(false);
    steps += 1;
    if (!measure) return;
    const state = machine.cpu_state();
    try {
      const stackPointer = state.sp();
      if (stackPointer >= STKGUARD && stackPointer <= STKTOP) {
        minimumStackPointer = Math.min(minimumStackPointer, stackPointer);
      }
    } finally {
      state.free();
    }
  }

  function interact(input, suffix, measure = true) {
    const previousLength = machine.serial_output().length;
    machine.enqueue_serial_input(input);
    for (let count = 0; count < 1_000_000; count += 1) {
      step(measure);
      const output = machine.serial_output();
      if (output.length > previousLength && endsWith(output, suffix)) return;
    }
    assert.fail(
      `${testCase.id} timed out waiting for ${JSON.stringify(suffix)}`,
    );
  }

  try {
    interact(new Uint8Array(), "\r\nA>", false);
    assert.ok(
      machine
        .read_ram(STKGUARD, STKGUEND - STKGUARD)
        .every((byte) => byte === SENTINEL),
      `${testCase.id} guard after boot`,
    );
    for (const interaction of testCase.interactions) {
      interact(
        Uint8Array.from(Buffer.from(interaction.input, "ascii")),
        interaction.suffix,
        interaction.measure !== false,
      );
    }
    assert.ok(
      machine
        .read_ram(STKGUARD, STKGUEND - STKGUARD)
        .every((byte) => byte === SENTINEL),
      `${testCase.id} overflowed the resident stack guard`,
    );
    assert.ok(
      minimumStackPointer >= STKBASE,
      `${testCase.id} used more than the 48-byte resident stack`,
    );
    return {
      id: testCase.id,
      steps,
      tStates,
      minimumStackPointer,
      stackBytesUsed: STKTOP - minimumStackPointer,
    };
  } finally {
    machine.free();
  }
}

const cases = [
  {
    id: "builtins-and-recovery",
    interactions: [
      { input: "DIR\r", suffix: "\r\nA>" },
      { input: "TYPE README.TXT\r", suffix: "\r\nA>" },
      { input: "DIR EXTRA\r", suffix: "\r\nA>" },
      { input: "TYPE\r", suffix: "\r\nA>" },
      { input: "ERA *.*\r", suffix: "ALL (Y/N)?" },
      { input: "N\r", suffix: "\r\nA>" },
      { input: "REN\r", suffix: "\r\nA>" },
      { input: "SAVE 1280 BIG.COM\r", suffix: "\r\nA>" },
      { input: "USER 16\r", suffix: "\r\nA>" },
      { input: "Q:\r", suffix: "\r\nA>" },
      { input: "ZZZ\r", suffix: "\r\nA>" },
    ],
  },
  {
    id: "successful-mutations",
    interactions: [
      { input: "REN RENAMED.TXT=README.TXT\r", suffix: "\r\nA>" },
      { input: "TYPE RENAMED.TXT\r", suffix: "\r\nA>" },
      { input: "REN README.TXT=RENAMED.TXT\r", suffix: "\r\nA>" },
      { input: "SAVE 1 PAGE.COM\r", suffix: "\r\nA>" },
      { input: "ERA PAGE.COM\r", suffix: "\r\nA>" },
      { input: "DIR PAGE.COM\r", suffix: "\r\nA>" },
    ],
  },
  {
    id: "confirmed-erase-all",
    interactions: [
      { input: "ERA *.*\r", suffix: "ALL (Y/N)?" },
      { input: "Y\r", suffix: "\r\nA>" },
      { input: "DIR\r", suffix: "\r\nA>" },
    ],
  },
  {
    id: "transient-warm-return",
    interactions: [
      { input: "SMOKE\r", suffix: "\r\nA>", measure: false },
      { input: "ZZZ\r", suffix: "\r\nA>" },
    ],
  },
].map(runCase);

const deepest = cases.reduce((left, right) =>
  left.minimumStackPointer <= right.minimumStackPointer ? left : right,
);
assert.equal(deepest.stackBytesUsed, 10, "measured CCP stack low-water mark");
console.log(
  JSON.stringify(
    {
      status: "passed",
      host: "triptych-host-wasm",
      stack: { guard: STKGUARD, base: STKBASE, top: STKTOP, bytes: 48 },
      deepest: deepest.id,
      cases,
    },
    undefined,
    2,
  ),
);
