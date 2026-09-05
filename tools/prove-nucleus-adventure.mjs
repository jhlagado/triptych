import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  mapSourceBundleOffset,
  prepareSourceBundle,
} from "../crates/triptych-host-wasm/web/source-bundle.js";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";
import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";

const root = resolve(import.meta.dirname, "..");
const sample = join(root, "samples/nucleus-adventure");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require("../dist/wasm/triptych_host_wasm.js");
const executable = join(root, "target/debug/triptych-host-native");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const prompt = "\r\nA>";
const cave = "CAVE> ";
const hill = "HILL> ";
const bye = "Bye.\r\n\r\nA>";
const finalSuffix = "ADVENTURE-PROOF-END\r\n\r\nA>";
const project = {
  schema: "triptych-nucleus-project-v1",
  sources: ["IO.NU", "MAIN.NU"],
  output: "GAME.NU",
  sourceMap: "GAME.MAP",
};

// This proof accepts only its fixed, valid 8.3 sample names. Production naming
// belongs to the disk adapter; no additional filename parser is introduced.
const bundleOptions = {
  canonicalName(name) {
    assert.ok(
      [...project.sources, project.output].includes(name),
      "unexpected sample bundle name",
    );
    return name;
  },
};

function recordText(bytes) {
  const end = bytes.indexOf(26);
  if (end < 0) return Buffer.from(bytes).toString("latin1");
  assert.ok(bytes.subarray(end).every((byte) => byte === 26));
  return Buffer.from(bytes.subarray(0, end)).toString("latin1");
}

function sourceRecords(disk) {
  return project.sources.map((name) => ({
    name,
    bytes: readCpm22File(disk, name),
  }));
}

async function packageProject(disk) {
  assert.deepEqual(
    JSON.parse(recordText(readCpm22File(disk, "BUILD.JSN"))),
    project,
  );
  const before = Uint8Array.from(disk);
  const bundle = await prepareSourceBundle(
    { sources: sourceRecords(disk), outputName: project.output },
    bundleOptions,
  );
  let packaged = installCpm22File(disk, {
    name: bundle.name,
    bytes: bundle.bytes,
    padByte: 26,
  });
  packaged = installCpm22File(packaged, {
    name: project.sourceMap,
    bytes: Buffer.from(JSON.stringify(bundle.map) + "\n", "ascii"),
    padByte: 26,
  });
  assert.deepEqual(disk, before, "packaging must preserve its input disk");
  for (const name of [...project.sources, "BUILD.JSN"])
    assert.deepEqual(readCpm22File(packaged, name), readCpm22File(disk, name));
  return packaged;
}

function wasmSession(bootstrap, disk, id, steps) {
  const machine = new TriptychCpu(bootstrap);
  machine.install_drive(0, disk, true);
  let transcript = Buffer.alloc(0);
  const checkpoints = [];
  try {
    for (const [name, input, suffix] of steps) {
      const before = transcript.length;
      assert.ok(machine.enqueue_serial_input(Buffer.from(input, "latin1")));
      let reached = false;
      let quiet = 0;
      for (let slice = 0; slice < 2000; slice += 1) {
        machine.run_slice(50_000, 500_000);
        const output = Buffer.from(machine.take_serial_output());
        transcript = Buffer.concat([transcript, output]);
        quiet = output.length ? 0 : quiet + 1;
        if (
          transcript.length > before &&
          (suffix === undefined
            ? quiet >= 10
            : transcript
                .subarray(-suffix.length)
                .equals(Buffer.from(suffix, "latin1")))
        ) {
          reached = true;
          break;
        }
      }
      assert.ok(
        reached,
        `${id}/${name}: ${transcript.subarray(before).toString("latin1")}`,
      );
      checkpoints.push({
        name,
        input,
        output: transcript.subarray(before).toString("latin1"),
        transcript: Buffer.from(transcript),
      });
    }
    return { disk: machine.export_drive(0), checkpoints };
  } finally {
    machine.free();
  }
}

async function nativeSession(bootstrapPath, diskPath, id, checkpoints) {
  const child = spawn(
    executable,
    [
      "--stop-after",
      finalSuffix,
      "--max-steps",
      "200000000",
      bootstrapPath,
      diskPath,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = Buffer.alloc(0);
  let stderr = "";
  let closed = false;
  let failure;
  child.stdout.on("data", (bytes) => {
    output = Buffer.concat([output, bytes]);
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes;
  });
  child.on("error", (error) => {
    failure = error;
  });
  child.stdin.on("error", (error) => {
    failure = error;
  });
  const completion = new Promise((resolve) => {
    child.on("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });
  try {
    for (const checkpoint of checkpoints) {
      if (checkpoint.input)
        child.stdin.write(Buffer.from(checkpoint.input, "latin1"));
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () =>
            finish(
              new Error(`native timeout ${id}/${checkpoint.name}: ${stderr}`),
            ),
          30_000,
        );
        function check() {
          if (failure) finish(failure);
          else if (output.length >= checkpoint.transcript.length) {
            try {
              assert.deepEqual(output, checkpoint.transcript);
              finish();
            } catch (error) {
              finish(error);
            }
          } else if (closed) finish(new Error(`native early exit: ${stderr}`));
        }
        function finish(error) {
          clearTimeout(timeout);
          child.stdout.off("data", check);
          child.off("close", check);
          error ? reject(error) : resolve();
        }
        child.stdout.on("data", check);
        child.on("close", check);
        check();
      });
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 30_000);
    try {
      assert.deepEqual(await completion, { code: 0, signal: null }, stderr);
    } finally {
      clearTimeout(timeout);
    }
    assert.deepEqual(output, checkpoints.at(-1).transcript);
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
const nucleus = built.manifest.components.find(({ id }) => id === "nucleus");
assert.ok(nucleus);
assert.equal(
  hash(readCpm22File(built.disk, "NUC.COM").subarray(0, nucleus.bytes)),
  nucleus.sha256,
  "actual guest compiler must match the pinned distribution",
);
const temporary = await mkdtemp(join(tmpdir(), "triptych-nucleus-adventure-"));
try {
  const bootstrapPath = join(temporary, "bootstrap.bin");
  await writeFile(bootstrapPath, built.bootstrap);
  const results = [];
  async function replay(id, disk, steps) {
    const wasm = wasmSession(built.bootstrap, disk, id, steps);
    const diskPath = join(temporary, `${id}.img`);
    await writeFile(diskPath, disk);
    const native = await nativeSession(
      bootstrapPath,
      diskPath,
      id,
      wasm.checkpoints,
    );
    assert.deepEqual(
      Uint8Array.from(native),
      wasm.disk,
      `${id}: complete native/WASM disk parity`,
    );
    results.push({
      id,
      initialDiskSha256: hash(disk),
      finalDiskSha256: hash(wasm.disk),
      checkpoints: wasm.checkpoints.map(
        ({ name, input, output, transcript }) => ({
          name,
          input,
          output,
          transcriptSha256: hash(transcript),
        }),
      ),
    });
    return wasm;
  }
  let disk = built.disk;
  const sourceInputs = [];
  for (const name of [...project.sources, "BUILD.JSN"]) {
    const bytes = await readFile(join(sample, name));
    sourceInputs.push({ name, bytes: bytes.length, sha256: hash(bytes) });
    disk = installCpm22File(disk, { name, bytes, padByte: 26 });
  }
  disk = installCpm22File(disk, {
    name: "DONE.TXT",
    bytes: Buffer.from("ADVENTURE-PROOF-END\r\n", "ascii"),
    padByte: 26,
  });
  const originalMain = recordText(readCpm22File(disk, "MAIN.NU"));
  const first = await replay("play-edit", await packageProject(disk), [
    ["boot", "", prompt],
    ["compile", "NUC GAME.NU\r", prompt],
    ["launch", "GAME\r", cave],
    ["take-at-home", "T", cave],
    ["invalid", "X", cave],
    ["cr", "\r", cave],
    ["lf", "\n", cave],
    ["west-edge", "W", cave],
    ["east", "E", hill],
    ["east-edge", "E", hill],
    ["take-key", "T", hill],
    ["take-again", "T", hill],
    ["win", "W", "You win! The key opens your cave.\r\n\r\nA>"],
    ["restart", "GAME\r", cave],
    ["quit", "Q", bye],
    ["edit", "EDIT MAIN.NU\r"],
    ["find", "\x06CAVE\r"],
    ["replace", "\x12BASE\r"],
    ["save", "\x13"],
    ["exit-editor", "\x11", prompt],
    ["finish", "TYPE DONE.TXT\r", finalSuffix],
  ]);
  const output = (session, name) =>
    session.checkpoints.find((c) => c.name === name).output;
  assert.doesNotMatch(output(first, "compile"), /Nucleus (host )?error/);
  assert.match(output(first, "take-at-home"), /No key here/);
  assert.match(output(first, "invalid"), /Use E, W, T or Q/);
  assert.match(output(first, "take-key"), /You have the key/);
  assert.equal(
    recordText(readCpm22File(first.disk, "MAIN.NU")).replaceAll("\r\n", "\n"),
    originalMain.replace("CAVE", "BASE").replaceAll("\r\n", "\n"),
    "actual EDIT must change only the requested source text",
  );
  assert.deepEqual(
    readCpm22File(first.disk, "IO.NU"),
    readCpm22File(disk, "IO.NU"),
  );
  const originalProgram = readCpm22File(first.disk, "GAME.COM");
  const second = await replay("rebuild", await packageProject(first.disk), [
    ["boot", "", prompt],
    ["compile", "NUC GAME.NU\r", prompt],
    ["edited-game", "GAME\r", "BASE> "],
    ["quit", "Q", bye],
    ["finish", "TYPE DONE.TXT\r", finalSuffix],
  ]);
  assert.doesNotMatch(output(second, "compile"), /Nucleus (host )?error/);
  const editedProgram = readCpm22File(second.disk, "GAME.COM");
  assert.notDeepEqual(editedProgram, originalProgram);
  const badSource = recordText(readCpm22File(second.disk, "MAIN.NU")).replace(
    "sub main()",
    "sub main(,)",
  );
  const bad = await packageProject(
    installCpm22File(second.disk, {
      name: "MAIN.NU",
      bytes: Buffer.from(badSource, "latin1"),
      padByte: 26,
    }),
  );
  const third = await replay("bad-build", bad, [
    ["boot", "", prompt],
    ["compile-error", "NUC GAME.NU\r", prompt],
    ["preserved-game", "GAME\r", "BASE> "],
    ["quit", "Q", bye],
    ["finish", "TYPE DONE.TXT\r", finalSuffix],
  ]);
  const diagnostic =
    /Nucleus error 86 P=01 O=([0-9A-F]{4}) L=([0-9A-F]{4}) C=([0-9A-F]{4})\r\n\r\nA>$/.exec(
      output(third, "compile-error"),
    );
  assert.ok(diagnostic, output(third, "compile-error"));
  const mapped = await mapSourceBundleOffset(
    {
      sources: sourceRecords(third.disk),
      bundle: {
        name: project.output,
        bytes: readCpm22File(third.disk, project.output),
      },
      map: JSON.parse(recordText(readCpm22File(third.disk, project.sourceMap))),
      offset: parseInt(diagnostic[1], 16),
    },
    bundleOptions,
  );
  const expectedOffset = badSource.indexOf("sub main(,)") + "sub main(".length;
  assert.deepEqual(mapped, {
    name: "MAIN.NU",
    offset: expectedOffset,
    line: badSource.slice(0, expectedOffset).split("\n").length,
    column: 10,
    synthetic: false,
  });
  assert.deepEqual(
    third.disk,
    bad,
    "failed compile/run must preserve complete input disk",
  );
  assert.deepEqual(readCpm22File(third.disk, "GAME.COM"), editedProgram);
  for (const name of ["GAME.$$$", "GAME.BAK"])
    assert.throws(() => readCpm22File(third.disk, name), /absent/);
  console.log(
    JSON.stringify(
      {
        status: "passed",
        platform: process.platform,
        distribution: built.manifest,
        sourceInputs,
        checkpointCount: results.reduce(
          (sum, result) => sum + result.checkpoints.length,
          0,
        ),
        originalProgram: {
          bytes: originalProgram.length,
          sha256: hash(originalProgram),
        },
        editedProgram: {
          bytes: editedProgram.length,
          sha256: hash(editedProgram),
        },
        mappedDiagnostic: mapped,
        sessions: results,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
