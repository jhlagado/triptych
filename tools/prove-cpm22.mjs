import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleAtomBinary as assemble } from "./lib/assemble-atom.mjs";
import { createZ80Runtime } from "@jhlagado/debug80-runtime/z80/runtime";
import {
  installCpm22File,
  readCpm22File,
} from "@jhlagado/debug80-runtime/platforms/cpm22/filesystem";
import { createEsp32SbcRuntime } from "../dist/cpu/runtime.js";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const sourceDirectory = join(repositoryRoot, "roms", "cpu");
const cpmImagePath = process.env.TRIPTYCH_CPM22_IMAGE;
if (!cpmImagePath) {
  throw new Error(
    "TRIPTYCH_CPM22_IMAGE must name a CP/M 2.2 disk image for the optional compatibility proof",
  );
}
const BIOS_SYSTEM_OFFSET = 0x1600;
const BOOT_ROM_BYTES = 0x100;
const BIOS_BYTES = 0x400;
const BACKING_SECTOR_BYTES = 512;

function padForBackingSectors(image) {
  const paddedLength =
    Math.ceil(image.length / BACKING_SECTOR_BYTES) * BACKING_SECTOR_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(image);
  return padded;
}

function transcript(machine, from = 0) {
  return Buffer.from(machine.serial.snapshot().output.slice(from)).toString(
    "latin1",
  );
}

function stepUntil(machine, counters, predicate, description) {
  const recentPcs = [];
  for (let count = 0; count < 5_000_000; count += 1) {
    recentPcs.push(machine.z80.getPC());
    if (recentPcs.length > 24) recentPcs.shift();
    const result = machine.z80.step();
    counters.instructions += 1;
    counters.tStates += result.cycles ?? 0;
    if (predicate()) return;
  }
  throw new Error(
    `timed out waiting for ${description}; pc=${machine.z80
      .getPC()
      .toString(
        16,
      )} a=${machine.z80.getRegisters().a.toString(16)} disk=${JSON.stringify(
      machine.disk.snapshot(),
    )} recentPcs=${recentPcs.map((pc) => pc.toString(16)).join(",")} transcript=${JSON.stringify(
      transcript(machine),
    )}`,
  );
}

function bootToPrompt(bootRom, diskImage) {
  const machine = createEsp32SbcRuntime({
    bootRom,
    drives: [{ image: diskImage }],
    createZ80Runtime: (ioHandlers) =>
      createZ80Runtime(
        { memory: new Uint8Array(0x10000), startAddress: 0 },
        0,
        ioHandlers,
      ),
  });
  const counters = { instructions: 0, tStates: 0 };
  stepUntil(
    machine,
    counters,
    () => transcript(machine).endsWith("A>"),
    "cold-boot prompt",
  );
  assert.equal(machine.memory.snapshot().bootRomEnabled, false);
  assert.equal(transcript(machine), "\r\nA>");
  return { machine, counters };
}

function runCommand(machine, counters, command, expected) {
  const start = machine.serial.snapshot().output.length;
  machine.serial.enqueueInput(Buffer.from(`${command}\r`, "ascii"));
  stepUntil(
    machine,
    counters,
    () => transcript(machine, start).endsWith("\r\nA>"),
    `${command} prompt`,
  );
  assert.equal(transcript(machine, start), expected);
}

const [bootRom, bios, bundledDisk] = await Promise.all([
  assemble(join(sourceDirectory, "bootstrap.asm")),
  assemble(join(repositoryRoot, "system", "cpm", "bios.asm")),
  readFile(resolve(cpmImagePath)),
]);
assert.equal(bootRom.length, BOOT_ROM_BYTES);
assert.equal(bios.length, BIOS_BYTES);

const mainProgram = Uint8Array.from([
  0x0e,
  0x09,
  0x11,
  0x09,
  0x01,
  0xcd,
  0x05,
  0x00,
  0xc9,
  ...Buffer.from("TRIPTYCH\r\n$", "ascii"),
]);
const proofImage = installCpm22File(
  Uint8Array.from(bundledDisk),
  "MAIN.COM",
  mainProgram,
);
proofImage.set(bios, BIOS_SYSTEM_OFFSET);
const paddedProofImage = padForBackingSectors(proofImage);

const first = bootToPrompt(bootRom, paddedProofImage);
runCommand(
  first.machine,
  first.counters,
  "MAIN",
  "MAIN\r\r\nTRIPTYCH\r\n\r\nA>",
);
runCommand(
  first.machine,
  first.counters,
  "SMOKE",
  "SMOKE\r\r\nWrote RESULT.TXT\r\n\r\nA>",
);

const persisted = first.machine.disk.exportPersistentImages()[0];
assert.ok(persisted);
const persistedCpmImage = persisted.slice(0, proofImage.length);
const resultFile = readCpm22File(persistedCpmImage, "RESULT.TXT");
assert.ok(resultFile, "SMOKE.COM did not publish RESULT.TXT");
const expectedResultText = "CP/M file services are working";
assert.equal(
  Buffer.from(resultFile.bytes.slice(0, expectedResultText.length)).toString(
    "ascii",
  ),
  expectedResultText,
);

const second = bootToPrompt(bootRom, persisted);
runCommand(
  second.machine,
  second.counters,
  "TYPE RESULT.TXT",
  "TYPE RESULT.TXT\r\r\nCP/M file services are working\r\n\r\nA>",
);

console.log(
  JSON.stringify(
    {
      status: "passed",
      guest: "Triptych CP/M 2.2 compatibility proof",
      bootRomBytes: bootRom.length,
      biosBytes: bios.length,
      firstBootAndCommands: first.counters,
      rebootAndReadback: second.counters,
      persistentFile: "RESULT.TXT",
    },
    undefined,
    2,
  ),
);
