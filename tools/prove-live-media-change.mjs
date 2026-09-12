import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { assembleAtomFile } from "./lib/assemble-atom.mjs";
import { buildTwoMibSystem } from "./lib/two-mib-system.mjs";

const root = resolve(import.meta.dirname, "..");
const { TriptychCpu, CpmDisk } = createRequire(import.meta.url)(
  join(root, "dist/wasm/triptych_host_wasm.js"),
);
// Fail before assembly when the coordinator has not built the new host API.
for (const name of ["prepare_drive_change", "commit_media_change"])
  assert.equal(
    typeof TriptychCpu.prototype[name],
    "function",
    `missing ${name}`,
  );
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixture = await assembleAtomFile(
  join(root, "test/fixtures/live-media-change.asm"),
);
assert.equal(fixture.base, 0x100);
const tuple = await buildTwoMibSystem(root, 4, { allowDirty: true });
function makeDisk(files, system) {
  const disk = CpmDisk.create_two_mib();
  try {
    for (const [name, bytes] of files) disk.add_import(name, bytes);
    const bytes = disk.export_candidate();
    if (system) bytes.set(system);
    return bytes;
  } finally {
    disk.free();
  }
}
const firstSentinel = new Uint8Array(128).fill(79);
const nextSentinel = new Uint8Array(128).fill(78);
const keep = new Uint8Array(4096).fill(0x5a);
const b = makeDisk([["SENTINEL.TXT", firstSentinel]]);
const next = makeDisk([
  ["KEEP.BIN", keep],
  ["SENTINEL.TXT", nextSentinel],
]);
function runGuest(program, expectGuestFailure = false) {
  const a = makeDisk([["LIVE.COM", program]], tuple.system);
  const machine = new TriptychCpu(tuple.bootstrap);
  let output = "";
  let steps = 0;
  function runUntil(marker) {
    const limit = steps + 5_000_000;
    while (
      (!output.includes(marker) ||
        (marker === "LIVE FAIL" && !machine.last_halted())) &&
      steps < limit
    ) {
      machine.run_slice(1000, 100_000);
      steps += 1000;
      output += Buffer.from(machine.take_serial_output()).toString("ascii");
      if (marker !== "LIVE FAIL") {
        assert.ok(!output.includes("LIVE FAIL"), output);
        assert.ok(!machine.last_halted(), output);
      }
    }
    assert.ok(output.includes(marker), `missing ${marker}: ${output}`);
  }
  function cpuState() {
    const state = machine.cpu_state();
    const flags = state.flags(),
      alternate = state.flags_prime();
    try {
      const registers = Object.fromEntries(
        [
          "a",
          "b",
          "c",
          "d",
          "e",
          "h",
          "l",
          "a_prime",
          "b_prime",
          "c_prime",
          "d_prime",
          "e_prime",
          "h_prime",
          "l_prime",
          "ix",
          "iy",
          "i",
          "r",
          "sp",
          "pc",
          "imode",
          "iff1",
          "iff2",
          "halted",
        ].map((name) => [name, state[name]()]),
      );
      for (const [prefix, value] of [
        ["f", flags],
        ["f_prime", alternate],
      ])
        registers[prefix] = Object.fromEntries(
          ["s", "z", "y", "h", "x", "p", "n", "c"].map((name) => [
            name,
            value[name](),
          ]),
        );
      return registers;
    } finally {
      flags.free();
      alternate.free();
      state.free();
    }
  }
  try {
    machine.install_drive(0, a, false);
    machine.install_drive(1, b, true);
    runUntil("A>");
    output = "";
    machine.enqueue_serial_input(Buffer.from("LIVE\r"));
    runUntil("LIVE DISK2 READY");
    assert.ok(
      machine.disk_management_ready(),
      "cooperative guest boundary is clean",
    );
    const cpuBefore = cpuState();
    const ramBefore = machine.read_ram(0, 65536);
    assert.deepEqual(
      machine.export_drive_checkpoint(1),
      b,
      "outgoing disk unchanged",
    );
    const ticket = machine.prepare_drive_change(1, next, true);
    assert.notEqual(ticket, 0, "prepared disk change");
    assert.equal(machine.commit_media_change(ticket), true);
    assert.deepEqual(cpuState(), cpuBefore, "live replacement preserves CPU");
    assert.deepEqual(
      machine.read_ram(0, 65536),
      ramBefore,
      "live replacement preserves all RAM",
    );
    assert.deepEqual(
      machine.export_drive_checkpoint(1),
      next,
      "incoming disk is exact",
    );
    output = "";
    machine.enqueue_serial_input(Buffer.from("x"));
    if (expectGuestFailure) {
      // This branch is reached only after all ordinary preparation, exact-media,
      // CPU and RAM checks above. A host exception is never an expected failure.
      runUntil("LIVE FAIL");
      assert.ok(!output.includes("LIVE CONTINUED PASS"), output);
      assert.ok(
        machine.last_halted(),
        "negative control reaches guest failure halt",
      );
      assert.deepEqual(
        machine.export_drive_checkpoint(0),
        a,
        "protected A remains exact",
      );
      return { status: "expected-guest-failure", steps, output };
    }
    runUntil("LIVE CONTINUED PASS");
    runUntil("A>");
    assert.deepEqual(
      machine.export_drive_checkpoint(0),
      a,
      "protected A remains exact",
    );
    const result = machine.export_drive_checkpoint(1);
    const disk = new CpmDisk(result);
    try {
      assert.deepEqual(disk.read_file("NEW.TXT"), nextSentinel);
      assert.deepEqual(disk.read_file("SENTINEL.TXT"), nextSentinel);
      assert.deepEqual(
        disk.read_file("KEEP.BIN"),
        keep,
        "new allocations preserve existing files",
      );
    } finally {
      disk.free();
    }
    return {
      status: "passed",
      profile: tuple.descriptor.residentProfile,
      fixtureBytes: fixture.bytes.length,
      oldDiskSha256: hash(b),
      incomingSha256: hash(next),
      savedSha256: hash(result),
      steps,
      output,
    };
  } finally {
    machine.free();
  }
}

const normal = runGuest(fixture.bytes);
// Retain the reviewer mutation as an executable negative control: remove only
// the assembled BDOS 37 call at CONT. The exact instruction check prevents a
// fixture edit from silently moving the mutation to unrelated instructions.
const withoutReset = fixture.bytes.slice();
const resetOffset = fixture.labels.CONT - fixture.base;
assert.ok(Number.isInteger(resetOffset) && resetOffset >= 0);
assert.deepEqual(
  Array.from(withoutReset.subarray(resetOffset, resetOffset + 8)),
  [0x11, 2, 0, 0x0e, 37, 0xcd, 5, 0],
  "CONT begins with LD DE,2 / LD C,37 / CALL 5",
);
withoutReset.fill(0, resetOffset, resetOffset + 8);
const negativeControl = runGuest(withoutReset, true);
console.log(JSON.stringify({ ...normal, negativeControl }));
