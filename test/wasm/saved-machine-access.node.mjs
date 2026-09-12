import test from "node:test";
import assert from "node:assert/strict";
import { prepareSavedMachineRuntime } from "../../crates/triptych-host-wasm/web/saved-machine-runtime.js";
import { prepareSavedMachineAdoption } from "../../crates/triptych-host-wasm/web/disk-box-adoption.js";
import { webcrypto } from "node:crypto";
const snapshot = () => ({
  bootstrap: { profile: "triptych-cpu-v0.1-8m-ab", bytes: new Uint8Array(256) },
  drives: {
    A: { name: "A", bytes: new Uint8Array(8388608) },
    B: { name: "B", bytes: new Uint8Array(8388608) },
  },
});
class Cpu {
  installs = [];
  install_drive(index, bytes, writable) {
    this.installs.push({ index, writable });
  }
  reset() {}
  free() {}
}
test("legacy adoption policy agrees with the actual one-drive runtime", async () => {
  const original = {
    bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256) },
    drives: { A: { name: "Legacy", bytes: new Uint8Array(256512) }, B: null },
  };
  const adopted = await prepareSavedMachineAdoption(original, {
    configurationId: "00000000-0000-4000-8000-000000000099",
    name: "Legacy",
    crypto: webcrypto,
  });
  const config = adopted.manifest.configurations[0];
  const runtime = await prepareSavedMachineRuntime({
    snapshot: original,
    TriptychCpu: Cpu,
    writable: true,
    slotWritable: config.slots.map((slot) => slot?.writable ?? false),
  });
  assert.equal(config.configuredCount, 1);
  assert.equal(runtime.media.configuredCount, config.configuredCount);
  assert.deepEqual(runtime.cpu.installs, [{ index: 0, writable: true }]);
  runtime.dispose();
});
for (const writable of [true, false])
  test(`mount protection remains effective with writer ownership ${writable}`, async () => {
    const runtime = await prepareSavedMachineRuntime({
      snapshot: snapshot(),
      TriptychCpu: Cpu,
      writable,
      slotWritable: [false, true],
    });
    assert.deepEqual(runtime.cpu.installs, [
      { index: 0, writable: false },
      { index: 1, writable },
    ]);
    runtime.dispose();
  });
test("invalid mount policies reject before CPU allocation", async () => {
  for (const policy of [[true], [true, 1], Array(2)]) {
    await assert.rejects(
      prepareSavedMachineRuntime({
        snapshot: snapshot(),
        TriptychCpu: class {
          constructor() {
            assert.fail("allocated invalid runtime");
          }
        },
        writable: true,
        slotWritable: policy,
      }),
      /policy/,
    );
  }
});
