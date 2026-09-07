// Explicit actual-WASM qualification. Inputs must come from an isolated frozen
// binding and a captured all-profile system build; this test never builds them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { webcrypto } from "node:crypto";
import test from "node:test";
import { prepareSavedMachineRuntime } from "../../crates/triptych-host-wasm/web/saved-machine-runtime.js";

assert(
  process.env.TRIPTYCH_WASM_MODULE,
  "TRIPTYCH_WASM_MODULE must identify the frozen binding",
);
assert(
  process.env.TRIPTYCH_TWO_MIB_FIXTURES,
  "TRIPTYCH_TWO_MIB_FIXTURES must identify captured system artifacts",
);
const { TriptychCpu } = createRequire(import.meta.url)(
  resolve(process.env.TRIPTYCH_WASM_MODULE),
);
const directory = process.env.TRIPTYCH_TWO_MIB_FIXTURES;

for (const count of [1, 16])
  test(`actual WASM n${count} preserves media, starts stopped and boots sparse media`, async () => {
    const path = join(directory, `n${String(count).padStart(2, "0")}`);
    const descriptor = JSON.parse(
      await readFile(join(path, "descriptor.json"), "utf8"),
    );
    const bootstrap = new Uint8Array(
      await readFile(join(path, "bootstrap.bin")),
    );
    const system = new Uint8Array(await readFile(join(path, "system.bin")));
    const deployment = {
      schema: "triptych-browser-deployment-v1",
      twoMibProfiles: [descriptor],
      assets: ["system", "bootstrap"].map((kind) => ({
        path: descriptor[kind].asset,
        bytes: descriptor[kind].bytes,
        sha256: descriptor[kind].sha256,
      })),
    };
    const snapshot = {
      schema: "triptych-drive-set-v4",
      configuredCount: count,
      bootstrap: { profile: descriptor.residentProfile, bytes: bootstrap },
      slots: Array.from({ length: count }, (_, index) => {
        if (index !== 0 && index !== count - 1) return null;
        const bytes = new Uint8Array(2097152);
        bytes.fill(0xe5, 16384, 16384 + 32768);
        if (index === 0) bytes.set(system);
        bytes[2097151] = index + 1;
        return {
          instanceId: `550e8400-e29b-41d4-a716-${String(index).padStart(12, "0")}`,
          name: `${index}.img`,
          bytes,
        };
      }),
    };
    const before = structuredClone(snapshot);
    const runtime = await prepareSavedMachineRuntime({
      snapshot,
      TriptychCpu,
      writable: false,
      deployment,
      crypto: webcrypto,
    });
    try {
      assert.equal(runtime.cpu.last_steps(), 0n);
      assert.equal(runtime.cpu.boot_rom_enabled(), true);
      const state = runtime.cpu.cpu_state();
      try {
        assert.equal(state.pc(), 0);
      } finally {
        state.free();
      }
      assert.deepEqual(runtime.captureCheckpoint(), before);
      assert.deepEqual(runtime.flushCounts(), Array(count).fill(0));
      for (const slot of snapshot.slots) if (slot) slot.bytes.fill(0);
      snapshot.bootstrap.bytes.fill(0);
      assert.deepEqual(runtime.captureCheckpoint(), before);
      if (count === 16)
        assert.throws(
          () => runtime.cpu.export_drive_checkpoint(1),
          /not installed/,
        );

      function until(suffix) {
        let text = "";
        for (let slice = 0; slice < 2000; slice++) {
          runtime.cpu.run_slice(50000, 500000);
          text += new TextDecoder().decode(runtime.cpu.take_serial_output());
          if (text.endsWith(suffix)) return text;
        }
        assert.fail(`guest did not reach ${JSON.stringify(suffix)}: ${text}`);
      }
      until("\r\nA>");
      if (count === 16) {
        assert(
          runtime.cpu.enqueue_serial_input(new TextEncoder().encode("P:\r")),
        );
        until("\r\nP>");
        assert(runtime.cpu.enqueue_serial_input(Uint8Array.of(3)));
        until("\r\nP>");
        const counts = runtime.flushCounts();
        assert(counts[0] > 0 && counts[15] > 0);
        assert(counts.slice(1, 15).every((value) => value === 0));
      }
      assert.deepEqual(runtime.captureCheckpoint(), before);
    } finally {
      runtime.dispose();
    }
    assert.throws(() => runtime.cpu, /disposed/);
  });
