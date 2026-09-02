import assert from "node:assert/strict";

import { runCpmHeadlessScenario } from "./lib/cpm-headless-scenario.mjs";

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
      expectedTranscript: secondTranscript,
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
assert.equal(result.sessions.length, 2);
assert.deepEqual(result.finalDrive, Uint8Array.from([17, 34, 2, 3]));
assert.deepEqual(closed, [0, 1]);
console.log("Headless CP/M scenario runner checks passed");
