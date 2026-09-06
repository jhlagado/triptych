import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assembleAtomFile } from "./lib/assemble-atom.mjs";

// Real Z80 port operations on both production Rust hosts. This deliberately
// bypasses CP/M: it proves the host boundary, not a multi-drive BIOS or browser.
const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require("../dist/wasm/triptych_host_wasm.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const { bytes: rom, base } = await assembleAtomFile(
  join(root, "test/fixtures/large-drive-controller.asm"),
);
assert.equal(base, 0);
assert.equal(rom.length, 256);
const initial = [Buffer.alloc(8388608, 0x31), Buffer.alloc(8388608, 0x62)];
const expected = initial.map((bytes) => Buffer.from(bytes));
const packets = [];
const replies = [];
const machine = new TriptychCpu(rom);
const packet = (command, drive, record, value) => {
  const bytes = Buffer.alloc(command === 2 ? 134 : 6);
  bytes[0] = command;
  bytes[1] = drive;
  bytes.writeUInt32LE(record, 2);
  if (command === 2) bytes.fill(value, 6);
  return bytes;
};

function transact(command, drive, record = 0, value, error = 0) {
  const input = packet(command, drive, record, value);
  packets.push(input);
  assert.ok(machine.enqueue_serial_input(input));
  const length = command === 1 ? 135 : 7;
  let output = Buffer.alloc(0);
  for (let slice = 0; slice < 100 && output.length < length; slice++) {
    machine.run_slice(5000, 50000);
    output = Buffer.concat([output, Buffer.from(machine.take_serial_output())]);
  }
  assert.equal(
    output.length,
    length,
    `reply for drive ${drive}, record ${record}`,
  );
  assert.equal(output[0], error === 4 ? 2 : error, "initial command error");
  const result = output.subarray(length - 6);
  assert.equal(
    result[0],
    error,
    `error for command ${command} on drive ${drive}`,
  );
  assert.equal(
    result.readUInt32LE(1),
    command === 4 && !error ? 65536 : record,
  );
  assert.equal(
    result[5] & 4,
    error ? 4 : 0,
    "status agrees with error register",
  );
  if (command === 1 && !error) {
    assert.deepEqual(
      output.subarray(1, 129),
      expected[drive].subarray(record * 128, record * 128 + 128),
    );
  }
  if (command === 2 && !error)
    expected[drive].fill(value, record * 128, record * 128 + 128);
  replies.push(output);
}

function checkpoint(drive, bytes) {
  assert.deepEqual(Buffer.from(machine.export_drive_checkpoint(drive)), bytes);
}

try {
  initial.forEach((bytes, drive) => machine.install_drive(drive, bytes, true));
  transact(4, 0);
  transact(4, 1);
  transact(2, 0, 65535, 0xa1);
  transact(2, 1, 65535, 0xb1);
  checkpoint(0, initial[0]);
  checkpoint(1, initial[1]);
  assert.equal(machine.disk_management_ready(), false);

  // The controller holds B's dirty cache line. FLUSH A must write that line
  // to B's live backing, but publish only A's checkpoint, not B's new bytes.
  transact(3, 0);
  checkpoint(0, expected[0]);
  checkpoint(1, initial[1]);
  assert.deepEqual(Buffer.from(machine.export_drive(1)), expected[1]);
  assert.equal(machine.drive_flush_count(0), 1);
  assert.equal(machine.drive_flush_count(1), 0);
  assert.equal(machine.disk_management_ready(), false);
  transact(3, 1);
  checkpoint(1, expected[1]);
  assert.equal(machine.disk_management_ready(), true);

  for (const record of [0, 16383, 16384, 16385, 65534]) {
    transact(2, 0, record, 0xa0 + (record % 16));
    transact(2, 1, record, 0xb0 + (record % 16));
    transact(1, 0, record);
    transact(1, 1, record);
  }
  transact(3, 0);
  transact(3, 1);
  for (const drive of [0, 1]) {
    checkpoint(drive, expected[drive]);
    // First rejected address and maximum 32-bit address must not alias zero
    // or the final record. Failed WRITE's payload causes bad-transfer-state.
    for (const record of [65536, 0xffffffff]) {
      transact(4, drive);
      // GET_CAPACITY overwrites the address register with 65536, not zero.
      transact(2, drive, record, 0xee, 4);
      transact(1, drive, record, undefined, 4);
      checkpoint(drive, expected[drive]);
    }
  }
  transact(4, 2, 0, undefined, 1);
  transact(3, 0);
  transact(3, 1);
  assert.equal(machine.disk_management_ready(), true);
  for (const drive of [0, 1]) {
    assert.deepEqual(Buffer.from(machine.export_drive(drive)), expected[drive]);
    checkpoint(drive, expected[drive]);
    assert.equal(
      hash(initial[drive]),
      hash(Buffer.alloc(8388608, drive ? 0x62 : 0x31)),
    );
  }
} finally {
  machine.free();
}

const evidence = await mkdtemp(
  join(tmpdir(), "triptych-large-drive-isolation-"),
);
const romPath = join(evidence, "controller.rom");
const disks = [join(evidence, "a.img"), join(evidence, "b.img")];
await writeFile(romPath, rom);
await Promise.all(disks.map((path, drive) => writeFile(path, initial[drive])));

async function nativeRun(input) {
  return await new Promise((resolve, reject) => {
    const process = spawn(join(root, "target/debug/triptych-host-native"), [
      "--max-steps",
      "20000000",
      romPath,
      ...disks,
    ]);
    const output = [];
    const errors = [];
    let failure;
    const timeout = setTimeout(() => {
      failure = new Error("native multi-drive controller proof timed out");
      process.kill();
    }, 60000);
    process.stdout.on("data", (bytes) => output.push(bytes));
    process.stderr.on("data", (bytes) => errors.push(bytes));
    process.on("error", (error) => {
      failure = error;
    });
    process.stdin.on("error", (error) => {
      failure ??= error;
    });
    process.on("close", (status) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (status !== 0)
        reject(new Error(Buffer.concat(errors).toString()));
      else resolve(Buffer.concat(output));
    });
    process.stdin.end(input);
  });
}

assert.deepEqual(
  await nativeRun(Buffer.concat([...packets, Buffer.from([0])])),
  Buffer.concat(replies),
  "native and WASM reply bytes, including intermediate status, agree",
);
for (const drive of [0, 1])
  assert.deepEqual(await readFile(disks[drive]), expected[drive]);

// A second process reads every changed boundary and its adjacent record.
// Compare full payloads and then whole disks; startup must not modify media.
const readPackets = [];
const readReplies = [];
for (const drive of [0, 1]) {
  for (const record of [
    0, 1, 16382, 16383, 16384, 16385, 16386, 65533, 65534, 65535,
  ]) {
    readPackets.push(packet(1, drive, record));
    const reply = Buffer.alloc(135);
    expected[drive].copy(reply, 1, record * 128, record * 128 + 128);
    reply.writeUInt32LE(record, 130);
    reply[134] = 0x50; // Ready, present, no transfer/error/dirty cache.
    readReplies.push(reply);
  }
}
assert.deepEqual(
  await nativeRun(Buffer.concat([...readPackets, Buffer.from([0])])),
  Buffer.concat(readReplies),
);
for (const drive of [0, 1])
  assert.deepEqual(await readFile(disks[drive]), expected[drive]);
const reopened = new TriptychCpu(rom);
try {
  expected.forEach((bytes, drive) =>
    reopened.install_drive(drive, bytes, true),
  );
  assert.ok(
    reopened.enqueue_serial_input(
      Buffer.concat([...readPackets, Buffer.from([0])]),
    ),
  );
  for (let slice = 0; slice < 100 && !reopened.last_halted(); slice++)
    reopened.run_slice(5000, 50000);
  assert.equal(reopened.last_halted(), true);
  assert.equal(
    reopened.cpu_state().sp(),
    0x8000,
    "ROM calls return with a balanced stack",
  );
  assert.deepEqual(
    Buffer.from(reopened.take_serial_output()),
    Buffer.concat(readReplies),
  );
  assert.equal(reopened.disk_management_ready(), true);
  for (const drive of [0, 1])
    assert.deepEqual(
      Buffer.from(reopened.export_drive_checkpoint(drive)),
      expected[drive],
    );
} finally {
  reopened.free();
}
const result = {
  status: "passed",
  scope:
    "two 8 MiB drives through Z80 controller ports on native/WASM; not CP/M or browser drive-set qualification",
  romSha256: hash(rom),
  imageBytesPerDrive: 8388608,
  commands: packets.length,
  freshProcessReads: readPackets.length,
  outputSha256: expected.map(hash),
  evidence,
};
await writeFile(
  join(evidence, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
