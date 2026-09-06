import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildLargeDiskSystem } from "./lib/large-disk-system.mjs";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";

// One-drive boot/save/rename pilot. This does not qualify all disk boundaries,
// browser management, migration, or the later multi-drive resident profile.
const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require("../dist/wasm/triptych_host_wasm.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const built = await buildCpmDistribution(root, {
  allowDirty: process.argv.includes("--allow-dirty"),
});
const system = await buildLargeDiskSystem(root, built);
const disk = Buffer.alloc(8 * 1024 * 1024, 0xe5);
disk.set(system.bytes);
const originalHash = hash(disk);
const machine = new TriptychCpu(built.bootstrap);
let transcript = "";
function until(predicate) {
  for (let slice = 0; slice < 4000; slice++) {
    machine.run_slice(50_000, 500_000);
    transcript += Buffer.from(machine.take_serial_output()).toString("latin1");
    if (predicate(transcript)) return;
  }
  throw new Error(`Large-disk pilot timed out: ${transcript.slice(-1000)}`);
}

const commands = ["SAVE 1 ZERO.BIN\r", "REN CHECK.BIN=ZERO.BIN\r", "DIR\r"];
const checkpoints = [];
let saved;
let finalCommand;
try {
  machine.install_drive(0, disk, true);
  until((output) => output.endsWith("\r\nA>"));
  checkpoints.push(transcript);
  // CP/M polls console input during disk work. Send one command at a time,
  // after the previous prompt, instead of losing typeahead to that polling.
  for (const command of commands) {
    const before = transcript.length;
    assert.ok(machine.enqueue_serial_input(Buffer.from(command, "ascii")));
    until((output) => output.length > before && output.endsWith("\r\nA>"));
    checkpoints.push(transcript);
  }
  assert.match(transcript, /CHECK\s+BIN/);
  assert.doesNotMatch(transcript, /Bad Sector|No space|Error|ERROR/);
  assert.ok(machine.disk_management_ready());
  saved = Buffer.from(machine.export_drive_checkpoint(0));
  assert.deepEqual(saved, Buffer.from(machine.export_drive(0)));
  finalCommand = transcript.slice(transcript.lastIndexOf("A>DIR\r"));
} finally {
  machine.free();
}
assert.equal(hash(disk), originalHash, "source image remains immutable");
assert.deepEqual(saved.subarray(0, 16384), disk.subarray(0, 16384));
assert.equal(saved.subarray(16385, 16396).toString("ascii"), "CHECK   BIN");
assert.equal(saved[16384 + 15], 2, "SAVE 1 writes two 128-byte records");
assert.equal(
  saved.readUInt16LE(16384 + 16),
  8,
  "first ordinary allocation block",
);
assert.deepEqual(saved.subarray(32768, 33024), Buffer.alloc(256));

const directory = await mkdtemp(join(tmpdir(), "triptych-large-disk-pilot-"));
const bootPath = join(directory, "bootstrap.bin");
const diskPath = join(directory, "native.img");
await writeFile(bootPath, built.bootstrap);
await writeFile(diskPath, disk);
await new Promise((resolve, reject) => {
  const native = spawn(join(root, "target/debug/triptych-host-native"), [
    "--stop-after",
    finalCommand,
    "--max-steps",
    "200000000",
    bootPath,
    diskPath,
  ]);
  let output = "";
  let stderr = "";
  let checkpoint = 0;
  let failure;
  const timeout = setTimeout(() => {
    failure = new Error(`Native pilot timed out: ${output.slice(-1000)}`);
    native.kill();
  }, 60000);
  native.stdout.on("data", (bytes) => {
    output += bytes.toString("latin1");
    try {
      while (
        checkpoint < checkpoints.length &&
        output.length >= checkpoints[checkpoint].length
      ) {
        assert.equal(
          output.slice(0, checkpoints[checkpoint].length),
          checkpoints[checkpoint],
        );
        if (checkpoint < commands.length)
          native.stdin.write(commands[checkpoint]);
        checkpoint++;
      }
    } catch (error) {
      failure = error;
      native.kill();
    }
  });
  native.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  native.on("error", (error) => {
    failure = error;
  });
  native.on("close", (status) => {
    clearTimeout(timeout);
    try {
      if (failure) throw failure;
      assert.equal(status, 0, stderr);
      assert.equal(output, transcript);
      assert.equal(checkpoint, checkpoints.length);
      resolve();
    } catch (error) {
      reject(error);
    }
  });
});
assert.deepEqual(
  await readFile(diskPath),
  saved,
  "native/WASM complete image parity",
);
const result = {
  status: "passed",
  scope: "one-drive boot/save/rename pilot, not full large-disk qualification",
  triptych: built.manifest.triptych,
  biosSha256: system.profile.bios.sha256,
  inputSha256: originalHash,
  outputSha256: hash(saved),
  imageBytes: saved.length,
  transcript,
  evidence: directory,
};
await writeFile(
  join(directory, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
