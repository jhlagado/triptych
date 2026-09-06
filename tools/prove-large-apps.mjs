import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TerminalBuffer } from "../crates/triptych-host-wasm/web/terminal.js";
import { buildLargeDiskSystem } from "./lib/large-disk-system.mjs";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu, CpmDisk } = require("../dist/wasm/triptych_host_wasm.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const prompt = "\r\nA>";
const cursor = "\x1b[2;21H";
const finalSuffix = "YK\r\nA>";
const editor = "EDIT INPUT   .NU       ^S Save  ^Q Quit";
const sessions = [
  {
    id: "migrated-atom-edit-nucleus",
    steps: [
      ["boot", "", prompt],
      ["atom-compile", "ATOM HELLO.ASM\r", prompt, "HELLO.COM written"],
      ["atom-run", "HELLO\r", prompt, "Hello from ATOM"],
      ["edit-open", "EDIT INPUT.NU\r", "\x1b[1;1H", editor],
      ["edit-find", "\x06'O'\r", cursor],
      ["edit-replace", "\x12'Y'\r", cursor, "'Y'"],
      ["edit-save", "\x13", cursor],
      ["edit-quit", "\x11", prompt],
      ["nucleus-compile", "NUC INPUT.NU\r", prompt],
      ["run", "INPUT\r", finalSuffix],
    ],
  },
  {
    id: "fresh-reopen",
    steps: [
      ["boot", "", prompt],
      ["source-read", "TYPE INPUT.NU\r", prompt, "writeOutputByte('Y')"],
      ["edit-reopen", "EDIT INPUT.NU\r", "\x1b[1;1H", editor],
      ["edit-quit", "\x11", prompt],
      ["run", "INPUT\r", finalSuffix],
    ],
  },
];

function withDisk(bytes, action) {
  const disk = new CpmDisk(bytes);
  try {
    return action(disk);
  } finally {
    disk.free();
  }
}
function screen(bytes) {
  const terminal = new TerminalBuffer();
  terminal.write(bytes);
  return terminal.snapshot();
}

function wasmSession(bootstrap, inputDisk, session) {
  const machine = new TriptychCpu(bootstrap);
  machine.install_drive(0, inputDisk, true);
  let transcript = Buffer.alloc(0);
  const checkpoints = [];
  try {
    for (const [id, input, suffix, required] of session.steps) {
      const before = transcript.length;
      // No typeahead: each command follows the previous complete output boundary.
      assert.ok(machine.enqueue_serial_input(Buffer.from(input, "latin1")));
      let reached = false;
      for (let slice = 0; slice < 1500; slice++) {
        machine.run_slice(50_000, 500_000);
        transcript = Buffer.concat([
          transcript,
          Buffer.from(machine.take_serial_output()),
        ]);
        const fresh = transcript.subarray(before);
        if (
          fresh.length > 0 &&
          transcript
            .subarray(-suffix.length)
            .equals(Buffer.from(suffix, "latin1")) &&
          (required === undefined ||
            fresh.includes(Buffer.from(required, "latin1")))
        ) {
          reached = true;
          break;
        }
      }
      assert.ok(
        reached,
        `${session.id}/${id}: WASM timeout: ${transcript.subarray(before).toString("latin1")}`,
      );
      assert.ok(
        machine.disk_management_ready(),
        `${session.id}/${id}: incomplete storage/input`,
      );
      const disk = Buffer.from(machine.export_drive_checkpoint(0));
      assert.equal(disk.length, 8_388_608);
      assert.deepEqual(
        disk,
        Buffer.from(machine.export_drive(0)),
        "checkpoint equals provider media",
      );
      checkpoints.push({
        id,
        input,
        transcript: Buffer.from(transcript),
        disk,
      });
    }
    return checkpoints;
  } finally {
    machine.free();
  }
}

async function nativeSession(bootstrapPath, diskPath, session, checkpoints) {
  const child = spawn(
    join(root, "target/debug/triptych-host-native"),
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
  let transcript = Buffer.alloc(0),
    stderr = "",
    failure,
    closed = false;
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
  const completion = new Promise((resolve) =>
    child.on("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    }),
  );
  function waitFor(length, id) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () =>
          finish(
            new Error(
              `${session.id}/${id}: native timeout ${transcript.length}/${length}: ${stderr}`,
            ),
          ),
        120_000,
      );
      function finish(error) {
        clearTimeout(timeout);
        child.stdout.off("data", changed);
        child.off("close", changed);
        child.off("error", changed);
        error ? reject(error) : resolve();
      }
      function changed() {
        if (failure) finish(failure);
        else if (transcript.length >= length) finish();
        else if (closed)
          finish(
            new Error(`${session.id}/${id}: native early exit: ${stderr}`),
          );
      }
      child.stdout.on("data", changed);
      child.on("close", changed);
      child.on("error", changed);
      changed();
    });
  }
  try {
    for (const checkpoint of checkpoints) {
      if (checkpoint.input)
        child.stdin.write(Buffer.from(checkpoint.input, "latin1"));
      await waitFor(checkpoint.transcript.length, checkpoint.id);
      assert.deepEqual(
        transcript,
        checkpoint.transcript,
        `${session.id}/${checkpoint.id}: exact transcript`,
      );
      assert.deepEqual(
        screen(transcript),
        screen(checkpoint.transcript),
        "terminal state parity",
      );
      assert.deepEqual(
        await readFile(diskPath),
        checkpoint.disk,
        `${session.id}/${checkpoint.id}: complete 8 MiB disk parity`,
      );
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      assert.deepEqual(await completion, { code: 0, signal: null }, stderr);
    } finally {
      clearTimeout(timeout);
    }
    assert.deepEqual(transcript, checkpoints.at(-1).transcript);
    assert.deepEqual(await readFile(diskPath), checkpoints.at(-1).disk);
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
const system = await buildLargeDiskSystem(root, built);
const systemArea = Buffer.from(system.bytes);
const source = Buffer.from(built.disk);
const original = Buffer.from(source);
const migrated = withDisk(source, (old) => {
  assert.equal(old.geometry_id(), "ibm3740");
  const result = Buffer.from(old.migrate_to_eight_mib(systemArea));
  assert.deepEqual(Buffer.from(old.export_source()), original);
  withDisk(result, (next) => {
    assert.equal(next.geometry_id(), "triptych-cpm-8m-v1");
    assert.deepEqual(next.file_names(), old.file_names());
    for (const name of old.file_names()) {
      assert.deepEqual(
        next.read_file(name),
        old.read_file(name),
        `migrated ${name}`,
      );
      assert.equal(next.file_read_only(name), old.file_read_only(name));
    }
  });
  return result;
});
assert.deepEqual(source, original, "migration source bytes unchanged");
assert.deepEqual(migrated.subarray(0, systemArea.length), systemArea);
const nucleus = built.manifest.components.find(
  (component) => component.id === "nucleus",
);
assert.ok(nucleus);
assert.equal(
  withDisk(migrated, (disk) =>
    hash(disk.read_file("NUC.COM").subarray(0, nucleus.bytes)),
  ),
  nucleus.sha256,
);
const evidence = await mkdtemp(join(tmpdir(), "triptych-large-apps-"));
const bootstrapPath = join(evidence, "bootstrap.bin");
await writeFile(bootstrapPath, built.bootstrap);
await writeFile(join(evidence, "source-legacy.img"), original);
const retainedDisks = new Set();
async function retainDisk(bytes) {
  const digest = hash(bytes);
  if (!retainedDisks.has(digest)) {
    await writeFile(join(evidence, `${digest}.img`), bytes);
    retainedDisks.add(digest);
  }
  return digest;
}
let disk = migrated;
const results = [];
for (const session of sessions) {
  const initialSha256 = await retainDisk(disk);
  const checkpoints = wasmSession(built.bootstrap, disk, session);
  const nativePath = join(evidence, `${session.id}-native.img`);
  await writeFile(nativePath, disk);
  await nativeSession(bootstrapPath, nativePath, session, checkpoints);
  const retained = [];
  for (const checkpoint of checkpoints) {
    const name = `${session.id}-${checkpoint.id}.console`;
    await writeFile(join(evidence, name), checkpoint.transcript);
    retained.push({
      id: checkpoint.id,
      input: checkpoint.input,
      transcriptFile: name,
      transcriptSha256: hash(checkpoint.transcript),
      diskSha256: await retainDisk(checkpoint.disk),
    });
    assert.deepEqual(
      checkpoint.disk.subarray(0, systemArea.length),
      systemArea,
      "system records preserved",
    );
  }
  disk = checkpoints.at(-1).disk;
  withDisk(disk, (current) => {
    assert.ok(current.file_names().includes("HELLO.COM"));
    assert.ok(current.file_names().includes("INPUT.COM"));
    const edited = Buffer.from(current.read_file("INPUT.NU")).toString(
      "latin1",
    );
    assert.match(edited, /writeOutputByte\('Y'\)/);
    assert.doesNotMatch(edited, /writeOutputByte\('O'\)/);
    for (const name of ["ATOM.COM", "NUC.COM", "EDIT.COM", "HELLO.ASM"])
      withDisk(original, (prior) =>
        assert.deepEqual(
          current.read_file(name),
          prior.read_file(name),
          `${name} unchanged`,
        ),
      );
  });
  if (session.id === "fresh-reopen")
    assert.equal(
      hash(disk),
      initialSha256,
      "read-only reopen preserves whole image",
    );
  results.push({
    id: session.id,
    initialDiskSha256: initialSha256,
    finalDiskSha256: hash(disk),
    checkpoints: retained,
  });
}
const result = {
  status: "passed",
  scope:
    "migrated one-drive applications and fresh native/WASM reopen, not hardware or multi-drive qualification",
  distribution: built.manifest,
  biosSha256: system.profile.bios.sha256,
  sourceDiskSha256: hash(original),
  imageBytes: disk.length,
  evidence,
  sessions: results,
};
await writeFile(
  join(evidence, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
