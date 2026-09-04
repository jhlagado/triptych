import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { retargetCpm22Atom } from "./lib/cpm22-atom-target.mjs";
import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";
import { runCpmHeadlessScenario } from "./lib/cpm-headless-scenario.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const firstTranscript = "\x1b[2J\x1b[HHELLO\x1b[7m!\x1b[0m";
const secondTranscript = "X".repeat(80);
const expectedInputs = [
  [Uint8Array.from([0x1b, 0x5b, 0x41, 0x0d]), Uint8Array.from([0x11])],
  [Uint8Array.from(Buffer.from("DIR\r", "ascii"))],
];
const transcripts = [firstTranscript, secondTranscript].map((text) =>
  Uint8Array.from(Buffer.from(text, "ascii")),
);

const scenario = {
  schema: "triptych-cpm-headless-scenario-v1",
  id: "headless-runner-self-check",
  expectedInitialDriveSha256:
    "054edec1d0211f624fed0cbca9d4f9400b0e491c43742af2c5b0abebf0c990d8",
  sessions: [
    {
      id: "ansi-attributes-and-byte-input",
      interactions: [
        {
          id: "draw",
          inputBytes: [...expectedInputs[0][0]],
          stopAfterAscii: "HELLO",
        },
        {
          id: "continue",
          inputBytes: [...expectedInputs[0][1]],
          stopAfterBytes: [...transcripts[0].slice(-4)],
        },
      ],
      expectedTranscriptBytes: [...transcripts[0]],
      expectedDriveSha256:
        "a64b1b0e32b6714e3b538145ec05e8299d1fca6194fc99ace039040cab3e506f",
      expectedTerminal: {
        text: "HELLO!",
        cursorRow: 0,
        cursorColumn: 6,
        currentAttributes: 0,
        wrapPending: false,
        bellCount: 0,
        screenSha256:
          "7a09ce3cea3ef96626548ec0d8e9350160ae308c70886cb4a4f005d5f6c49d73",
      },
    },
    {
      id: "fresh-machine-with-persisted-drive",
      inputAscii: "DIR\r",
      stopAfterAscii: "XXXX",
      expectedTranscriptSha256:
        "62ed4e42c5a7926bd285c5db0e944709876ef0cdfb9862bfb54fcb3758e7c60b",
      expectedTranscriptBytesLength: 80,
      expectedDriveSha256:
        "4444bdef64b16c42c32b4f536c6950aab0f82602efbde724702536791cbc61f7",
      expectedTerminal: {
        text: secondTranscript,
        cursorRow: 0,
        cursorColumn: 79,
        currentAttributes: 0,
        wrapPending: true,
        bellCount: 0,
        screenSha256:
          "126e63dd7f2aa3794fbcf3bba61d0d842360bb92f668b0d14640fb5d11b714c9",
      },
    },
  ],
};

let machineIndex = 0;
const closed = [];
const result = runCpmHeadlessScenario({
  scenario,
  initialDrive: Uint8Array.from([0, 1, 2, 3]),
  createMachine(drive) {
    const index = machineIndex;
    machineIndex += 1;
    if (index === 1) assert.deepEqual(drive, Uint8Array.from([17, 1, 2, 3]));
    let output = new Uint8Array();
    let interactionIndex = -1;
    return {
      enqueueInput(bytes) {
        interactionIndex += 1;
        assert.deepEqual(bytes, expectedInputs[index][interactionIndex]);
      },
      runSlice() {
        output =
          index === 0 && interactionIndex === 0
            ? transcripts[0].slice(0, firstTranscript.indexOf("HELLO") + 5)
            : transcripts[index];
      },
      serialOutput() {
        return output;
      },
      exportDrive() {
        drive[index] = index === 0 ? 17 : 34;
        return drive;
      },
      close() {
        closed.push(index);
      },
    };
  },
});

assert.equal(result.id, scenario.id);
assert.equal(result.initialDriveSha256, scenario.expectedInitialDriveSha256);
assert.equal(result.sessions.length, 2);
assert.deepEqual(result.finalDrive, Uint8Array.from([17, 34, 2, 3]));
assert.deepEqual(closed, [0, 1]);
assert.throws(
  () =>
    runCpmHeadlessScenario({
      scenario: {
        ...scenario,
        id: "wrong-initial-drive",
        expectedInitialDriveSha256: "0".repeat(64),
      },
      initialDrive: Uint8Array.from([0, 1, 2, 3]),
      createMachine() {
        throw new Error("machine must not start for the wrong disk");
      },
    }),
  /wrong-initial-drive initial drive image/,
);

const baseDisk = new Uint8Array(
  await readFile(resolve(repositoryRoot, "third_party", "cpm22", "cpm22.img")),
);
const largeFile = Uint8Array.from(
  { length: 129 * 128 - 7 },
  (_, index) => (index * 29 + 7) & 0xff,
);
const installed = installCpm22File(baseDisk, {
  name: "CHECK.DAT",
  bytes: largeFile,
  padByte: 0x1a,
});
const readLarge = readCpm22File(installed, "CHECK.DAT");
assert.equal(readLarge.length, 129 * 128);
assert.deepEqual(readLarge.slice(0, largeFile.length), largeFile);
assert.ok(readLarge.slice(largeFile.length).every((byte) => byte === 0x1a));
const replacement = Uint8Array.of(1, 2, 3);
const replaced = installCpm22File(installed, {
  name: "CHECK.DAT",
  bytes: replacement,
});
assert.deepEqual(readCpm22File(replaced, "CHECK.DAT").slice(0, 3), replacement);
assert.equal(readCpm22File(replaced, "CHECK.DAT").length, 128);

const atom = readCpm22File(baseDisk, "ATOM.COM");
const residentAtom = retargetCpm22Atom(atom, {
  start: 0xec00,
  capacity: 0x0e00,
});
assert.equal(residentAtom.length, 15_029);
assert.equal(
  sha256(residentAtom),
  "072d43cb9be3a21daaa923399d7423dbeeeb699895d572b5aea4a112ce420cca",
);
console.log("Headless CP/M scenario runner checks passed");
