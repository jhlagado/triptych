// Use the normal host build unless a caller supplies a qualified binding.
// This test never builds or replaces shared output.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assembleAtomBinary } from "../../tools/lib/assemble-atom.mjs";

const { TriptychCpu } = createRequire(import.meta.url)(
  process.env.TRIPTYCH_WASM_MODULE
    ? resolve(process.env.TRIPTYCH_WASM_MODULE)
    : resolve(import.meta.dirname, "../../dist/wasm/triptych_host_wasm.js"),
);

function state(cpu) {
  const value = cpu.cpu_state();
  try {
    return [
      value.pc(),
      value.sp(),
      value.r(),
      value.iff1(),
      value.iff2(),
      cpu.last_steps(),
      cpu.last_tstates(),
      cpu.last_halted(),
      cpu.last_interrupt_accepted(),
      cpu.boot_rom_enabled(),
    ];
  } finally {
    value.free();
  }
}

test("actual WASM ticket blocks mutating APIs, keeps failed ticket frozen and cancels intact", () => {
  const cpu = new TriptychCpu(new Uint8Array(256));
  try {
    cpu.install_drive(0, new Uint8Array(512).fill(1), true);
    cpu.write_ram(512, Uint8Array.of(8, 9));
    const before = state(cpu);
    const ram = cpu.ram_image();
    const incoming = new Uint8Array(512).fill(2);
    const ticket = cpu.prepare_drive_change(0, incoming, false);
    assert(ticket > 0);
    incoming.fill(7);
    assert(cpu.media_change_pending());
    assert.equal(cpu.disk_management_ready(), false);
    assert.throws(() => cpu.write_ram(512, Uint8Array.of(0)), /frozen/);
    // Freeze is independently enforced even before the first instruction.
    assert.throws(() => cpu.install_drive(0, incoming, true), /frozen/);
    if (typeof cpu.set_conformance_cpu_field === "function")
      assert.throws(() => cpu.set_conformance_cpu_field("pc", 900), /frozen/);
    cpu.reset();
    assert.equal(cpu.step(true), 0);
    assert.equal(cpu.run_slice(10, 100), 3);
    assert.equal(cpu.enqueue_serial_input(Uint8Array.of(65)), false);
    assert.equal(cpu.prepare_drive_eject(0), 0);
    assert.equal(cpu.commit_media_change(ticket + 1), false);
    assert.equal(cpu.cancel_media_change(ticket + 1), false);
    assert(cpu.media_change_pending());
    assert.deepEqual(state(cpu), before);
    assert.deepEqual(cpu.ram_image(), ram);
    assert.deepEqual(cpu.export_drive(0), new Uint8Array(512).fill(1));
    assert(cpu.cancel_media_change(ticket));
    assert.equal(cpu.media_change_pending(), false);
    assert.deepEqual(cpu.export_drive(0), new Uint8Array(512).fill(1));
    assert.deepEqual(state(cpu), before);
    assert(cpu.step(false) > 0);

    const running = state(cpu);
    const next = cpu.prepare_drive_change(
      0,
      new Uint8Array(512).fill(3),
      false,
    );
    assert(next > ticket);
    assert.equal(cpu.commit_media_change(ticket), false);
    assert(cpu.media_change_pending());
    assert(cpu.commit_media_change(next));
    assert.deepEqual(state(cpu), running);
    assert.deepEqual(cpu.ram_image(), ram);
    assert.deepEqual(
      cpu.export_drive_checkpoint(0),
      new Uint8Array(512).fill(3),
    );
    const eject = cpu.prepare_drive_eject(0);
    assert(eject > next);
    assert(cpu.commit_media_change(eject));
    assert.throws(() => cpu.export_drive(0), /not installed/);
    assert.deepEqual(state(cpu), running);
  } finally {
    cpu.free();
  }
});

test("actual WASM protected install and prepared mount reject guest writes without changing exports", async () => {
  // Reuse the ATOM fixture that attempts two complete writes and one flush.
  // It has no stack/RAM use and ends with a read of the second backing sector.
  const program = await assembleAtomBinary(
    fileURLToPath(new URL("fixtures/flush-checkpoint.asm", import.meta.url)),
  );
  const boot = new Uint8Array(256);
  assert(program.length <= boot.length);
  boot.set(program);
  for (const prepared of [false, true]) {
    const cpu = new TriptychCpu(boot);
    try {
      const original = new Uint8Array(1024).fill(7);
      if (prepared) {
        const ticket = cpu.prepare_drive_change(0, original, false);
        assert(ticket > 0);
        assert(cpu.commit_media_change(ticket));
      } else cpu.install_drive(0, original, false);
      const exported = cpu.export_drive_checkpoint(0);
      exported.fill(9);
      assert.deepEqual(cpu.export_drive_checkpoint(0), original);
      cpu.set_io_trace_enabled(true);
      assert.equal(cpu.run_slice(2000, 100000), 0);
      const trace = Array.from(cpu.take_io_trace());
      const writes = trace.filter((entry) => (entry & 0x1000000) !== 0);
      assert.equal(
        writes.filter(
          (entry) => ((entry >>> 8) & 255) === 0x10 && (entry & 255) === 2,
        ).length,
        2,
      );
      assert.equal(
        writes.filter((entry) => ((entry >>> 8) & 255) === 0x16).length,
        256,
      );
      assert.equal(cpu.drive_flush_count(0), 1);
      assert.deepEqual(cpu.export_drive(0), original);
      assert.deepEqual(cpu.export_drive_checkpoint(0), original);
    } finally {
      cpu.free();
    }
  }
});
