import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TerminalBuffer } from "../crates/triptych-host-wasm/web/terminal.js";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";
import { readCpm22File } from "./lib/cpm22-disk.mjs";
import { terminalSnapshotSha256 } from "./lib/cpm-headless-scenario.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require("../dist/wasm/triptych_host_wasm.js");
const executable = join(root, "target/debug/triptych-host-native");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const prompt = "\r\nA>";
const cursor = "\x1b[2;21H";
const finalSuffix = "YK\r\nA>";
const sessions = [
  {
    id: "atom-edit-save-compile-run",
    steps: [
      ["boot", "", prompt],
      ["atom-compile", "ATOM HELLO.ASM\r", prompt, "HELLO.COM written"],
      ["atom-run", "HELLO\r", prompt, "Hello from ATOM"],
      ["open", "EDIT INPUT.NU\r", "\x1b[1;1H"],
      ["find", "\x06'O'\r", cursor],
      ["replace", "\x12'Y'\r", cursor],
      ["save", "\x13", cursor],
      ["quit", "\x11", prompt],
      ["compile", "NUC INPUT.NU\r", prompt],
      ["run", "INPUT\r", finalSuffix],
    ],
  },
  {
    id: "fresh-process-reopen-run",
    steps: [
      ["boot", "", prompt],
      ["type", "TYPE INPUT.NU\r", prompt],
      ["reopen", "EDIT INPUT.NU\r", "\x1b[1;1H"],
      ["quit", "\x11", prompt],
      ["run", "INPUT\r", finalSuffix],
    ],
  },
];

function terminal(bytes) {
  const screen = new TerminalBuffer();
  screen.write(bytes);
  return screen.snapshot();
}

function wasmSession(bootstrap, disk, session) {
  const machine = new TriptychCpu(bootstrap);
  machine.install_drive(0, disk, true);
  let transcript = Buffer.alloc(0);
  const checkpoints = [];
  try {
    for (const [id, input, suffix, expectedOutput] of session.steps) {
      const before = transcript.length;
      assert.ok(machine.enqueue_serial_input(Buffer.from(input, "latin1")));
      let reached = false;
      for (let slice = 0; slice < 1500; slice++) {
        machine.run_slice(50_000, 500_000);
        transcript = Buffer.concat([
          transcript,
          Buffer.from(machine.take_serial_output()),
        ]);
        if (
          transcript.length > before &&
          transcript
            .subarray(-suffix.length)
            .equals(Buffer.from(suffix, "latin1"))
        ) {
          reached = true;
          break;
        }
      }
      assert.ok(reached, `${session.id}/${id}: WASM checkpoint timed out`);
      if (expectedOutput !== undefined) {
        assert.ok(
          transcript
            .subarray(before)
            .includes(Buffer.from(expectedOutput, "latin1")),
          `${session.id}/${id}: missing successful output ${expectedOutput}`,
        );
      }
      checkpoints.push({ id, input, transcript: Buffer.from(transcript) });
    }
    return { checkpoints, disk: Buffer.from(machine.export_drive(0)) };
  } finally {
    machine.free();
  }
}

async function nativeSession(bootstrapPath, diskPath, session, checkpoints) {
  const child = spawn(
    executable,
    [
      "--stop-after",
      finalSuffix,
      "--max-steps",
      "1000000000",
      bootstrapPath,
      diskPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let transcript = Buffer.alloc(0);
  let stderr = "";
  let failure;
  let closed = false;
  child.stdout.on("data", (bytes) => {
    transcript = Buffer.concat([transcript, bytes]);
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  child.on("error", (error) => {
    failure = error;
  });
  child.stdin.on("error", (error) => {
    failure = error;
  });
  const completion = new Promise((resolveCompletion) => {
    child.on("close", (code, signal) => {
      closed = true;
      resolveCompletion({ code, signal });
    });
  });

  function waitForBytes(length) {
    return new Promise((resolveWait, reject) => {
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              `${session.id}: native timeout at ${transcript.length}/${length} bytes: ${stderr}`,
            ),
          ),
        120_000,
      );
      function finish(error) {
        clearTimeout(timeout);
        child.stdout.off("data", changed);
        child.off("close", changed);
        child.off("error", changed);
        error ? reject(error) : resolveWait();
      }
      function changed() {
        if (failure) finish(failure);
        else if (transcript.length >= length) finish();
        else if (closed)
          finish(new Error(`${session.id}: native exited early: ${stderr}`));
      }
      child.stdout.on("data", changed);
      child.on("close", changed);
      child.on("error", changed);
      changed();
    });
  }

  try {
    for (const checkpoint of checkpoints) {
      if (checkpoint.input.length)
        child.stdin.write(Buffer.from(checkpoint.input, "latin1"));
      await waitForBytes(checkpoint.transcript.length);
      assert.deepEqual(
        transcript,
        checkpoint.transcript,
        `${session.id}/${checkpoint.id}: raw console bytes`,
      );
      assert.deepEqual(
        terminal(transcript),
        terminal(checkpoint.transcript),
        `${session.id}/${checkpoint.id}: terminal snapshot`,
      );
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const result = await completion;
      assert.deepEqual(
        result,
        { code: 0, signal: null },
        `${session.id}: native exit: ${stderr}`,
      );
    } finally {
      clearTimeout(timeout);
    }
    assert.deepEqual(
      transcript,
      checkpoints.at(-1).transcript,
      `${session.id}: complete raw console bytes`,
    );
    return await readFile(diskPath);
  } finally {
    if (!closed) {
      child.kill("SIGKILL");
      await completion;
    }
  }
}

const built = await buildCpmDistribution(root, {
  allowDirty: process.argv.includes("--allow-dirty"),
});
const temporary = await mkdtemp(join(tmpdir(), "triptych-host-parity-"));
try {
  const bootstrapPath = join(temporary, "bootstrap.bin");
  const diskPath = join(temporary, "native.img");
  await writeFile(bootstrapPath, built.bootstrap);
  await writeFile(diskPath, built.disk);
  let wasmDisk = Buffer.from(built.disk);
  const results = [];
  for (const session of sessions) {
    const wasm = wasmSession(built.bootstrap, wasmDisk, session);
    const nativeDisk = await nativeSession(
      bootstrapPath,
      diskPath,
      session,
      wasm.checkpoints,
    );
    assert.deepEqual(
      nativeDisk,
      wasm.disk,
      `${session.id}: whole disk checkpoint`,
    );
    const files = [];
    for (const name of ["HELLO.COM", "INPUT.NU", "INPUT.COM"]) {
      const nativeFile = readCpm22File(nativeDisk, name);
      const wasmFile = readCpm22File(wasm.disk, name);
      assert.deepEqual(nativeFile, wasmFile, `${session.id}: exported ${name}`);
      if (name === "INPUT.NU")
        assert.match(
          Buffer.from(nativeFile).toString("ascii"),
          /writeOutputByte\('Y'\)/,
        );
      files.push({ name, bytes: nativeFile.length, sha256: hash(nativeFile) });
    }
    results.push({
      id: session.id,
      checkpoints: wasm.checkpoints.map(({ id, transcript }) => ({
        id,
        transcriptBytes: transcript.length,
        transcriptSha256: hash(transcript),
        terminalSha256: terminalSnapshotSha256(terminal(transcript)),
      })),
      diskSha256: hash(nativeDisk),
      files,
    });
    wasmDisk = wasm.disk;
  }
  console.log(
    JSON.stringify(
      {
        status: "passed",
        platform: process.platform,
        distribution: built.manifest,
        sessions: results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
