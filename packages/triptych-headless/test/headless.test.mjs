import assert from "node:assert/strict";
import test from "node:test";

import { DISK_TIMING_PROFILES, SYSTEM_PROFILE, bootMachine, createDisk } from "../src/index.mjs";

// A COM program that prints a line through BDOS function 9 and returns.
const HELLO = Uint8Array.from([
  0x11, 0x09, 0x01, // LD DE,TEXT
  0x0e, 0x09, //       LD C,9
  0xc3, 0x05, 0x00, // JP 5
  0x00,
  ...Buffer.from("HELLO FROM TRIPTYCH\r\n$", "latin1"),
]);

test("a new disk carries the N04 system and starts empty", () => {
  const disk = createDisk();
  assert.equal(SYSTEM_PROFILE, "triptych-cpu-v0.1-2m-n04");
  assert.equal(disk.image().length, 2 * 1024 * 1024);
  assert.deepEqual(disk.fileNames(), []);
  assert.equal(disk.freeDirectoryEntries(), 1024);
});

test("files round-trip in whole CP/M records", () => {
  const disk = createDisk([["NOTE.TXT", Buffer.from("ATOM\r\n", "latin1")]]);
  assert.deepEqual(disk.fileNames(), ["NOTE.TXT"]);
  const stored = disk.readFile("note.txt");
  assert.equal(stored.length, 128);
  assert.equal(Buffer.from(stored.subarray(0, 6)).toString("latin1"), "ATOM\r\n");
  assert.equal(disk.readFile("MISSING.TXT"), undefined);
});

test("a machine boots, lists the directory and runs a program", () => {
  const machine = bootMachine([createDisk([["HELLO.COM", HELLO]]).image()]);
  try {
    assert.match(machine.run("DIR"), /HELLO\s+COM/);
    assert.match(machine.run("HELLO"), /HELLO FROM TRIPTYCH\r\n/);
    assert.ok(machine.tstates() > 0);
  } finally {
    machine.close();
  }
});

test("a program's writes are visible on the exported drive", () => {
  const machine = bootMachine([createDisk([["HELLO.COM", HELLO]]).image()]);
  try {
    machine.run("SAVE 1 COPY.COM");
    const disk = machine.disk(0);
    assert.ok(disk.fileNames().includes("COPY.COM"));
    assert.equal(disk.readFile("COPY.COM").length, 256);
  } finally {
    machine.close();
  }
});

test("disk timing models a floppy without changing what the guest prints", () => {
  const instant = bootMachine([createDisk([["HELLO.COM", HELLO]]).image()]);
  const floppy = bootMachine([createDisk([["HELLO.COM", HELLO]]).image()], {
    diskTiming: { profile: "8in-sssd" },
  });
  try {
    assert.deepEqual(DISK_TIMING_PROFILES, ["8in-sssd", "5in-dsdd", "3in-dsdd"]);
    assert.equal(instant.diskTimingReport(), undefined);

    // Booting reads the resident system: seconds on an 8-inch floppy.
    const boot = floppy.diskTimingReport();
    assert.equal(boot.profile, "8in-sssd");
    assert.equal(boot.mode, "account");
    assert.ok(boot.recordReads > 100, `${boot.recordReads} reads`);
    assert.ok(boot.diskMs > 5_000, `${boot.diskMs} ms`);
    assert.equal(boot.cylinders, 77);
    assert.ok(boot.maxCylinder >= 0 && boot.maxCylinder < boot.cylinders);

    // Restarting the counters measures one command.
    floppy.setDiskTiming({ profile: "5in-dsdd" });
    assert.equal(floppy.run("HELLO"), instant.run("HELLO"));
    const hello = floppy.diskTimingReport();
    assert.equal(hello.profile, "5in-dsdd");
    assert.ok(hello.recordReads > 0);
    assert.ok(hello.diskMs > 0 && hello.diskMs < boot.diskMs);
    assert.ok(hello.modelledMs >= hello.diskMs);

    floppy.setDiskTiming(null);
    assert.equal(floppy.diskTimingReport(), undefined);
    assert.throws(() => floppy.setDiskTiming({ profile: "tape" }), RangeError);
    assert.throws(() => floppy.setDiskTiming({ profile: "8in-sssd", mode: "fast" }), RangeError);
  } finally {
    instant.close();
    floppy.close();
  }
});

test("stall mode makes the guest wait in emulated time", () => {
  const disk = createDisk([["HELLO.COM", HELLO]]).image();
  const account = bootMachine([disk], { diskTiming: { profile: "8in-sssd" } });
  const stall = bootMachine([disk], { diskTiming: { profile: "8in-sssd", mode: "stall" } });
  try {
    const skipped = account.diskTimingReport();
    const waited = stall.diskTimingReport();
    assert.equal(waited.mode, "stall");
    // The stalled guest spends the disk wait polling, so it runs more T-states.
    assert.ok(stall.tstates() - account.tstates() > (skipped.diskMs / 1000) * 4_000_000 * 0.9);
    assert.equal(waited.recordReads, skipped.recordReads);
  } finally {
    account.close();
    stall.close();
  }
});
