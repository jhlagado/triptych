import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { TerminalBuffer } from "../../crates/triptych-host-wasm/web/terminal.js";

export const CPM_HEADLESS_SCENARIO_SCHEMA = "triptych-cpm-headless-scenario-v1";
export const TERMINAL_SNAPSHOT_SCHEMA = "triptych-terminal-snapshot-v1";

function bytesFromFixture(session, textField, bytesField) {
  const text = session[textField];
  const bytes = session[bytesField];
  assert.equal(
    (text === undefined) !== (bytes === undefined),
    true,
    `${session.id} must define exactly one of ${textField} and ${bytesField}`,
  );
  if (bytes !== undefined) {
    assert.ok(
      Array.isArray(bytes),
      `${session.id} ${bytesField} must be an array`,
    );
    for (const byte of bytes) {
      assert.ok(
        Number.isInteger(byte) && byte >= 0 && byte <= 0xff,
        `${session.id} ${bytesField} contains a non-byte value`,
      );
    }
    return Uint8Array.from(bytes);
  }
  assert.equal(
    typeof text,
    "string",
    `${session.id} ${textField} must be text`,
  );
  for (const character of text) {
    assert.ok(
      character.codePointAt(0) <= 0x7f,
      `${session.id} ${textField} must contain 7-bit ASCII only`,
    );
  }
  return Uint8Array.from(Buffer.from(text, "ascii"));
}

function endsWith(bytes, suffix) {
  if (suffix.length > bytes.length) return false;
  const offset = bytes.length - suffix.length;
  for (let index = 0; index < suffix.length; index += 1) {
    if (bytes[offset + index] !== suffix[index]) return false;
  }
  return true;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function terminalSnapshotSha256(snapshot) {
  const metadata = Buffer.from(
    `${TERMINAL_SNAPSHOT_SCHEMA}\ncolumns=${snapshot.columns}\nrows=${snapshot.rows}\ncursor-row=${snapshot.cursorRow}\ncursor-column=${snapshot.cursorColumn}\ncurrent-attributes=${snapshot.currentAttributes}\nwrap-pending=${snapshot.wrapPending ? 1 : 0}\nbell-count=${snapshot.bellCount}\n`,
    "ascii",
  );
  return createHash("sha256")
    .update(metadata)
    .update(snapshot.cells)
    .update(snapshot.attributes)
    .digest("hex");
}

function assertTerminal(id, expected, transcript) {
  assert.ok(expected && typeof expected === "object", id);
  const terminal = new TerminalBuffer();
  terminal.write(transcript);
  const snapshot = terminal.snapshot();

  assert.equal(terminal.text(), expected.text, `${id} terminal text`);
  assert.equal(snapshot.cursorRow, expected.cursorRow, `${id} cursor row`);
  assert.equal(
    snapshot.cursorColumn,
    expected.cursorColumn,
    `${id} cursor column`,
  );
  assert.equal(snapshot.bellCount, expected.bellCount, `${id} bell count`);
  if (expected.currentAttributes !== undefined) {
    assert.equal(
      snapshot.currentAttributes,
      expected.currentAttributes,
      `${id} current attributes`,
    );
  }
  if (expected.wrapPending !== undefined) {
    assert.equal(
      snapshot.wrapPending,
      expected.wrapPending,
      `${id} pending wrap`,
    );
  }
  const screenSha256 = terminalSnapshotSha256(snapshot);
  if (expected.screenSha256 !== undefined) {
    assert.equal(screenSha256, expected.screenSha256, `${id} screen`);
  }
  return { snapshot, screenSha256 };
}

function sessionInteractions(session) {
  if (session.interactions === undefined) return [session];
  assert.ok(
    Array.isArray(session.interactions) && session.interactions.length > 0,
    `${session.id} interactions must be a non-empty array`,
  );
  for (const field of [
    "inputAscii",
    "inputBytes",
    "stopAfterAscii",
    "stopAfterBytes",
  ]) {
    assert.equal(
      session[field],
      undefined,
      `${session.id} cannot mix interactions with top-level ${field}`,
    );
  }
  return session.interactions;
}

function validateScenario(scenario) {
  assert.equal(scenario.schema, CPM_HEADLESS_SCENARIO_SCHEMA);
  assert.equal(typeof scenario.id, "string");
  assert.ok(
    scenario.systemBdos === undefined ||
      scenario.systemBdos === "oracle" ||
      scenario.systemBdos === "triptych",
    `${scenario.id} systemBdos must be oracle or triptych`,
  );
  assert.match(
    scenario.expectedInitialDriveSha256,
    /^[0-9a-f]{64}$/,
    `${scenario.id} expectedInitialDriveSha256`,
  );
  assert.ok(Array.isArray(scenario.sessions) && scenario.sessions.length > 0);
}

/**
 * Replay a declarative CP/M session without a browser or physical terminal.
 *
 * createMachine receives a private disk-image copy and returns a small adapter:
 * enqueueInput(bytes), runSlice(), serialOutput(), exportDrive(), and close().
 */
export function runCpmHeadlessScenario({
  scenario,
  initialDrive,
  createMachine,
  maximumSlices = 400,
}) {
  validateScenario(scenario);
  let persisted = Uint8Array.from(initialDrive);
  const initialDriveSha256 = sha256(persisted);
  assert.equal(
    initialDriveSha256,
    scenario.expectedInitialDriveSha256,
    `${scenario.id} initial drive image`,
  );
  const results = [];

  for (const session of scenario.sessions) {
    assert.equal(typeof session.id, "string");
    const expectedTranscript = bytesFromFixture(
      session,
      "expectedTranscript",
      "expectedTranscriptBytes",
    );
    const machine = createMachine(Uint8Array.from(persisted));
    try {
      let transcript = new Uint8Array();
      let totalSlices = 0;
      const interactionResults = [];
      for (const [index, interaction] of sessionInteractions(
        session,
      ).entries()) {
        const interactionId = `${session.id}/${interaction.id ?? index + 1}`;
        const input = bytesFromFixture(
          { ...interaction, id: interactionId },
          "inputAscii",
          "inputBytes",
        );
        const suffix = bytesFromFixture(
          { ...interaction, id: interactionId },
          "stopAfterAscii",
          "stopAfterBytes",
        );
        machine.enqueueInput(input);
        let slices = 0;
        for (; slices < maximumSlices; slices += 1) {
          machine.runSlice();
          transcript = Uint8Array.from(machine.serialOutput());
          if (endsWith(transcript, suffix)) break;
        }
        assert.ok(
          endsWith(transcript, suffix),
          `${interactionId} timed out after ${maximumSlices} slices: ${JSON.stringify(Buffer.from(transcript).toString("ascii"))}`,
        );
        totalSlices += slices + 1;
        const interactionResult = {
          id: interaction.id ?? String(index + 1),
          slices: slices + 1,
          transcriptBytes: transcript.length,
        };
        if (interaction.expectedTerminal !== undefined) {
          const { screenSha256 } = assertTerminal(
            interactionId,
            interaction.expectedTerminal,
            transcript,
          );
          interactionResult.screenSha256 = screenSha256;
        }
        interactionResults.push(interactionResult);
      }
      assert.deepEqual(
        transcript,
        expectedTranscript,
        `${session.id} raw serial transcript: ${JSON.stringify(Buffer.from(transcript).toString("ascii"))}`,
      );

      const { snapshot, screenSha256 } = assertTerminal(
        session.id,
        session.expectedTerminal,
        transcript,
      );
      persisted = Uint8Array.from(machine.exportDrive());
      const driveSha256 = sha256(persisted);
      if (session.expectedDriveSha256 !== undefined) {
        assert.equal(
          driveSha256,
          session.expectedDriveSha256,
          `${session.id} drive image`,
        );
      }
      results.push({
        id: session.id,
        slices: totalSlices,
        interactions: interactionResults,
        transcriptBytes: transcript.length,
        transcriptSha256: sha256(transcript),
        driveSha256,
        terminal: {
          rows: snapshot.rows,
          columns: snapshot.columns,
          cursorRow: snapshot.cursorRow,
          cursorColumn: snapshot.cursorColumn,
          currentAttributes: snapshot.currentAttributes,
          wrapPending: snapshot.wrapPending,
          bellCount: snapshot.bellCount,
          screenSha256,
        },
      });
    } finally {
      machine.close();
    }
  }

  return {
    id: scenario.id,
    systemBdos: scenario.systemBdos ?? "oracle",
    initialDriveSha256,
    sessions: results,
    finalDrive: persisted,
  };
}
