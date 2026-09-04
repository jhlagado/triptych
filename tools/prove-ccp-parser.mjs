import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  assembleAtomFile(resolve(repositoryRoot, "roms", "cpu", "ccp", "ccp.asm")),
  assembleAtomBinary(
    resolve(repositoryRoot, "roms", "cpu", "bdos", "bdos.asm"),
  ),
  assembleAtomBinary(resolve(repositoryRoot, "system", "cpm", "bios.asm")),
  readFile(resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img")),
]);
const { STKGUARD, STKGUEND } = ccp.labels;
const disk = padForBackingSectors(sourceDisk);
disk.set(ccp.bytes, 0x0000);
disk.set(bdos, 0x0800);
disk.set(bios, 0x1600);

const boundaryCases = [
  "",
  " ",
  "       ",
  "  dIr   readme.txt",
  "DIR A:README.TXT",
  "DIR *.*",
  "DIR A*.T*",
  `DIR ${"A".repeat(7)}.TXT`,
  `DIR ${"A".repeat(8)}.TXT`,
  `DIR ${"A".repeat(9)}.TXT`,
  `DIR FILE.${"A".repeat(2)}`,
  `DIR FILE.${"A".repeat(3)}`,
  `DIR FILE.${"A".repeat(4)}`,
  "DIR *.* EXTRA",
  "TYPE",
  "TYPE README.TXT EXTRA",
  "TYPE *.TXT",
  "TYPE .TXT",
  "TYPE A<B.TXT",
  "TYPE A>B.TXT",
  "TYPE A,B.TXT",
  "TYPE A;B.TXT",
  "TYPE AB:CD.TXT",
  "TYPE A[B.TXT",
  "TYPE A]B.TXT",
  "TYPE A%B.TXT",
  "TYPE A|B.TXT",
  "TYPE A(B.TXT",
  "TYPE A)B.TXT",
  "TYPE A/B.TXT",
  "TYPE A\\B.TXT",
  `TYPE ${"T".repeat(8)}.${"C".repeat(3)}`,
  `TYPE ${"T".repeat(9)}.COM`,
  "ERA",
  "ERA README.TXT EXTRA",
  "REN",
  "REN =README.TXT",
  "REN .TXT=README.TXT",
  "REN NEW.TXT=",
  "REN NEW.TXT= ",
  "REN NEW.TXT=.TXT",
  "REN NEW.TXT=*.TXT",
  "REN NEW.TXT README.TXT",
  "REN NEW.TXT=README.TXT EXTRA",
  `REN ${"N".repeat(9)}.TXT=README.TXT`,
  "SAVE",
  "SAVE -1 BAD.COM",
  "SAVE +1 BAD.COM",
  "SAVE 1",
  "SAVE 0 .COM",
  "SAVE 0 *.COM",
  "SAVE 1 BAD.COM EXTRA",
  "SAVE 228 BAD.COM",
  "SAVE 255 BAD.COM",
  "SAVE 256 BAD.COM",
  "SAVE 999999999999999999999 BAD.COM",
  "USER",
  "USER -1",
  "USER +1",
  "USER 00",
  "USER 16",
  "USER 99",
  "USER 999999999999999999999",
  "Q:",
  "Z:",
  "AA:",
  "DIRX",
  "TYP",
  "THISCOMMANDISLONGERTHANEIGHT",
  "SMO*",
  `TYPE ${"X".repeat(122)}`,
];

const requiredTranscriptFragments = new Map([
  ["  dIr   readme.txt", "A: README   TXT"],
  ["DIR A:README.TXT", "A: README   TXT"],
  ["DIR *.*", "A: README   TXT"],
  ["DIR A*.T*", "NO FILE"],
  [`DIR ${"A".repeat(8)}.TXT`, "NO FILE"],
  [`DIR ${"A".repeat(9)}.TXT`, `${"A".repeat(9)}.TXT?`],
  ["TYPE *.TXT", "*.TXT?"],
  ["TYPE .TXT", ".TXT?"],
  ["TYPE A,B.TXT", "A,B.TXT?"],
  ["TYPE AB:CD.TXT", "AB:CD.TXT?"],
  ["TYPE A\\B.TXT", "A\\B.TXT?"],
  ["REN =README.TXT", "=README.TXT?"],
  ["REN .TXT=README.TXT", ".TXT=README.TXT?"],
  ["SAVE 228 BAD.COM", "228?"],
  ["USER 16", "16?"],
  ["Q:", "Q:?"],
  ["SMO*", "SMO*?"],
]);

let randomState = 0x54524950;
function random() {
  randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0;
  return randomState;
}

const fuzzAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ._:-=";
const fuzzCases = Array.from({ length: 64 }, () => {
  const length = 1 + (random() % 122);
  let argument = "";
  for (let index = 0; index < length; index += 1) {
    argument += fuzzAlphabet[random() % fuzzAlphabet.length];
  }
  return `TYPE ${argument}`.slice(0, 127);
});

function runCase(command, index) {
  const machine = new TriptychCpu(bootRom);
  machine.install_drive(0, disk, true);
  let steps = 0;

  function interact(input, suffix) {
    const previousLength = machine.serial_output().length;
    machine.enqueue_serial_input(Uint8Array.from(Buffer.from(input, "ascii")));
    let quietSteps = 0;
    let observedLength = previousLength;
    for (let count = 0; count < 1_000_000; count += 1) {
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
      // A malformed token can itself contain the bytes CR LF A >. Require the
      // apparent prompt to remain quiet before treating it as the real prompt.
      if (quietSteps >= 256) {
        return Buffer.from(output.slice(previousLength)).toString("latin1");
      }
    }
    assert.fail(
      `case ${index} timed out after ${JSON.stringify(command)} waiting for ${JSON.stringify(suffix)}`,
    );
  }

  try {
    interact("", "\r\nA>");
    const before = sha256(machine.export_drive(0));
    const transcript = interact(`${command}\r`, "\r\nA>");
    const requiredFragment = requiredTranscriptFragments.get(command);
    if (requiredFragment !== undefined) {
      assert.ok(
        transcript.includes(requiredFragment),
        `case ${index} omitted ${JSON.stringify(requiredFragment)}: ${JSON.stringify(command)}`,
      );
    }
    assert.equal(
      sha256(machine.export_drive(0)),
      before,
      `case ${index} mutated the disk: ${JSON.stringify(command)}`,
    );
    assert.ok(
      machine
        .read_ram(STKGUARD, STKGUEND - STKGUARD)
        .every((byte) => byte === SENTINEL),
      `case ${index} crossed the stack guard: ${JSON.stringify(command)}`,
    );
    const recovery = interact("DIR README.TXT\r", "\r\nA>");
    assert.match(
      recovery,
      /A: README\s+TXT/,
      `case ${index} did not recover: ${JSON.stringify(command)}`,
    );
    assert.equal(
      sha256(machine.export_drive(0)),
      before,
      `case ${index} recovery command mutated the disk`,
    );
    return { command, transcriptBytes: transcript.length, steps };
  } finally {
    machine.free();
  }
}

const boundaryResults = boundaryCases.map(runCase);
const fuzzResults = fuzzCases.map((command, index) =>
  runCase(command, boundaryCases.length + index),
);

console.log(
  JSON.stringify(
    {
      status: "passed",
      host: "triptych-host-wasm",
      seed: "0x54524950",
      maximumLineBytes: 127,
      boundaryCases: boundaryResults.length,
      fuzzCases: fuzzResults.length,
      totalSteps: [...boundaryResults, ...fuzzResults].reduce(
        (sum, result) => sum + result.steps,
        0,
      ),
    },
    undefined,
    2,
  ),
);
