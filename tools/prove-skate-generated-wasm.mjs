import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require(
  join(root, "dist", "wasm", "triptych_host_wasm.js"),
);
const image = await readFile(
  join(root, "test/fixtures/skate-provider-trace.com"),
);
const expectedHash =
  "8755b74847de73a856ff8a196fc51a922955f601977f9c384efabd9e45d17593";
assert.equal(createHash("sha256").update(image).digest("hex"), expectedHash);

const entry = 0x0100;
const outputVector = 0x22a4;
const inputVector = 0x22a7;
const outputStub = 0xf000;
const inputStub = 0xf003;
const cpu = new TriptychCpu(new Uint8Array(256));
try {
  cpu.write_ram(entry, image);
  cpu.write_ram(0, Uint8Array.of(0x76)); // COM return target used by the CP/M proof.
  cpu.write_ram(outputStub, Uint8Array.of(0xd3, 0x00, 0xc9));
  cpu.write_ram(inputStub, Uint8Array.of(0xdb, 0x00, 0xc9));
  cpu.write_ram(
    outputVector,
    Uint8Array.of(0xc3, outputStub & 0xff, outputStub >> 8),
  );
  cpu.write_ram(
    inputVector,
    Uint8Array.of(0xc3, inputStub & 0xff, inputStub >> 8),
  );
  cpu.disable_boot_rom_for_execution();
  cpu.set_execution_cpu_field("pc", entry);
  cpu.set_execution_cpu_field("sp", 0xf800);
  assert.equal(cpu.enqueue_serial_input(Uint8Array.of(81)), true);
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    const status = cpu.run_slice(50_000, 500_000);
    if (status === 0) break;
    assert.notEqual(status, 3);
    assert.notEqual(status, 4);
    assert.ok(attempt < 1_999, "generated program exceeded slice budget");
  }
  assert.deepEqual([...cpu.take_serial_output()], [81, 13, 10]);
  assert.equal(cpu.last_halted(), true);
  console.log(
    JSON.stringify(
      { status: "passed", target: "wasm", output: [81, 13, 10] },
      null,
      2,
    ),
  );
} finally {
  cpu.free();
}
