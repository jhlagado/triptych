import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

import { assembleAtomBinary } from "./lib/assemble-atom.mjs";
import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require(
  resolve(repositoryRoot, "dist", "wasm", "triptych_host_wasm.js"),
);
const BACKING_SECTOR_BYTES = 512;
const DIRECTORY_OFFSET = 52 * 128;
const DIRECTORY_ENTRIES = 64;
const DIRECTORY_ENTRY_BYTES = 32;
const RESERVED_BLOCKS = 2;
const MAXIMUM_BLOCK = 242;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function padForBackingSectors(image) {
  const length =
    Math.ceil(image.length / BACKING_SECTOR_BYTES) * BACKING_SECTOR_BYTES;
  const padded = new Uint8Array(length);
  padded.set(image);
  return padded;
}

function endsWith(output, suffix) {
  return Buffer.from(output).toString("latin1").endsWith(suffix);
}

const [bootRom, ccp, bdos, bios, sourceDisk] = await Promise.all([
  assembleAtomBinary(resolve(repositoryRoot, "roms", "cpu", "bootstrap.asm")),
  assembleAtomBinary(resolve(repositoryRoot, "roms", "cpu", "ccp", "ccp.asm")),
  assembleAtomBinary(
    resolve(repositoryRoot, "roms", "cpu", "bdos", "bdos.asm"),
  ),
  assembleAtomBinary(resolve(repositoryRoot, "system", "cpm", "bios.asm")),
  readFile(resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img")),
]);

const baseDisk = padForBackingSectors(sourceDisk);
baseDisk.set(ccp, 0x0000);
baseDisk.set(bdos, 0x0800);
baseDisk.set(bios, 0x1600);

function directoryEntry(image, index) {
  const start = DIRECTORY_OFFSET + index * DIRECTORY_ENTRY_BYTES;
  return image.subarray(start, start + DIRECTORY_ENTRY_BYTES);
}

function fillDirectory(image) {
  const result = Uint8Array.from(image);
  for (let index = 0; index < DIRECTORY_ENTRIES; index += 1) {
    const entry = directoryEntry(result, index);
    if (entry[0] !== 0xe5) continue;
    entry.fill(0);
    entry[0] = 0;
    entry.set(
      Buffer.from(`D${index.toString().padStart(7, "0")}TMP`, "ascii"),
      1,
    );
  }
  return result;
}

function fillDataBlocks(image) {
  const used = new Set();
  for (let index = 0; index < DIRECTORY_ENTRIES; index += 1) {
    const entry = directoryEntry(image, index);
    if (entry[0] > 0x0f) continue;
    for (const block of entry.subarray(16, 32)) {
      if (block !== 0) used.add(block);
    }
  }
  const free = [];
  for (let block = RESERVED_BLOCKS; block <= MAXIMUM_BLOCK; block += 1) {
    if (!used.has(block)) free.push(block);
  }
  assert.ok(free.length > 0, "source disk must have free data blocks");
  return installCpm22File(image, {
    name: "FILLER.BIN",
    bytes: new Uint8Array(free.length * 1024).fill(0x5a),
  });
}

function faultedReadDisk(image) {
  const result = image.slice(0, 16 * 1024);
  const entry = Array.from({ length: DIRECTORY_ENTRIES }, (_, index) =>
    directoryEntry(result, index),
  ).find((candidate) => candidate[0] === 0xe5);
  assert.ok(entry, "source disk must have a free directory entry");
  entry.fill(0);
  entry[0] = 0;
  entry.set(Buffer.from("FAULT   TXT", "ascii"), 1);
  entry[15] = 1;
  entry[16] = MAXIMUM_BLOCK;
  return result;
}

function runCase(testCase) {
  const machine = new TriptychCpu(bootRom);
  machine.install_drive(0, testCase.disk, testCase.writable);
  let steps = 0;

  function interact(input, suffix = "\r\nA>") {
    const previousLength = machine.serial_output().length;
    machine.enqueue_serial_input(Uint8Array.from(Buffer.from(input, "ascii")));
    let quietSteps = 0;
    let observedLength = previousLength;
    for (let count = 0; count < 2_000_000; count += 1) {
      machine.step(false);
      steps += 1;
      const output = machine.serial_output();
      if (output.length !== observedLength) {
        observedLength = output.length;
        quietSteps = 0;
      } else if (output.length > previousLength && endsWith(output, suffix)) {
        quietSteps += 1;
      } else {
        quietSteps = 0;
      }
      if (quietSteps >= 256) {
        return Buffer.from(output.slice(previousLength)).toString("latin1");
      }
    }
    const tail = Buffer.from(machine.serial_output())
      .toString("latin1")
      .slice(-240);
    assert.fail(
      `${testCase.id} timed out after ${JSON.stringify(input)}: ${JSON.stringify(tail)}`,
    );
  }

  try {
    interact("");
    const initialDrive = machine.export_drive(0);
    const initialReadme =
      testCase.verifyReadme === false
        ? undefined
        : sha256(readCpm22File(initialDrive, "README.TXT"));
    let failure;
    if (testCase.acknowledge) {
      failure = interact(testCase.input, testCase.failureFragment);
      failure += interact("\r");
    } else {
      failure = interact(testCase.input);
    }
    assert.ok(
      failure.includes(testCase.failureFragment),
      `${testCase.id} omitted ${JSON.stringify(testCase.failureFragment)}`,
    );
    const recovery = interact("DIR README.TXT\r");
    assert.match(recovery, /A: README\s+TXT/, `${testCase.id} recovery`);
    const finalDrive = machine.export_drive(0);
    if (initialReadme !== undefined) {
      assert.equal(
        sha256(readCpm22File(finalDrive, "README.TXT")),
        initialReadme,
        `${testCase.id} changed an unrelated file`,
      );
    }
    testCase.assertDrive(initialDrive, finalDrive);
    return {
      id: testCase.id,
      steps,
      initialDriveSha256: sha256(initialDrive),
      finalDriveSha256: sha256(finalDrive),
    };
  } finally {
    machine.free();
  }
}

function assertUnchanged(id) {
  return (before, after) =>
    assert.equal(sha256(after), sha256(before), `${id} changed the disk`);
}

const fullDisk = fillDataBlocks(baseDisk);
const fillerDigest = sha256(readCpm22File(fullDisk, "FILLER.BIN"));
const cases = [
  {
    id: "read-only-save",
    disk: baseDisk,
    writable: false,
    input: "SAVE 1 NEW.COM\r",
    failureFragment: "Bdos Err On A: Bad Sector",
    acknowledge: true,
    assertDrive: assertUnchanged("read-only-save"),
  },
  {
    id: "read-only-rename",
    disk: baseDisk,
    writable: false,
    input: "REN RENAMED.TXT=README.TXT\r",
    failureFragment: "Bdos Err On A: Bad Sector",
    acknowledge: true,
    assertDrive: assertUnchanged("read-only-rename"),
  },
  {
    id: "read-only-erase",
    disk: baseDisk,
    writable: false,
    input: "ERA README.TXT\r",
    failureFragment: "Bdos Err On A: Bad Sector",
    acknowledge: true,
    assertDrive: assertUnchanged("read-only-erase"),
  },
  {
    id: "full-directory-save",
    disk: fillDirectory(baseDisk),
    writable: true,
    input: "SAVE 0 NEW.COM\r",
    failureFragment: "NO SPACE",
    assertDrive: assertUnchanged("full-directory-save"),
  },
  {
    id: "full-disk-save",
    disk: fullDisk,
    writable: true,
    input: "SAVE 1 NEW.COM\r",
    failureFragment: "NO SPACE",
    assertDrive(_before, after) {
      assert.equal(
        sha256(readCpm22File(after, "FILLER.BIN")),
        fillerDigest,
        "full-disk-save changed the allocation filler",
      );
      assert.equal(
        readCpm22File(after, "NEW.COM").length,
        0,
        "full-disk-save must retain its documented empty partial file",
      );
    },
  },
  {
    id: "faulted-read",
    disk: faultedReadDisk(baseDisk),
    writable: true,
    input: "TYPE FAULT.TXT\r",
    failureFragment: "Bdos Err On A: Bad Sector",
    acknowledge: true,
    verifyReadme: false,
    assertDrive: assertUnchanged("faulted-read"),
  },
].map(runCase);

console.log(
  JSON.stringify(
    {
      status: "passed",
      host: "triptych-host-wasm",
      cases,
    },
    undefined,
    2,
  ),
);
