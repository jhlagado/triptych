import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyDiskBoxView,
  sameDiskBoxView,
  diskBoxViewSlotWritable,
} from "../../crates/triptych-host-wasm/web/disk-box-app-store.js";
import {
  copySavedMachine,
  encodeSavedMachine,
} from "../../crates/triptych-host-wasm/web/saved-machine.js";

function view(count = 4) {
  return {
    schema: "triptych-drive-set-v4",
    configuredCount: count,
    bootstrap: {
      profile: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
      bytes: new Uint8Array(256),
    },
    slots: Array(count).fill(null),
  };
}
for (const count of [1, 4, 16])
  test(`empty A is a ${count}-slot disk-box view, never a bootable archive`, async () => {
    const source = view(count),
      copied = copyDiskBoxView(source);
    assert.deepEqual(copied, source);
    assert(sameDiskBoxView(copied, source));
    assert.throws(() => copySavedMachine(source), /A media is required/);
    await assert.rejects(
      async () => encodeSavedMachine(source),
      /A media is required/,
    );
  });
test("view capture preserves mounted IDs and owns Buffer bytes", () => {
  const source = view();
  source.slots[3] = {
    instanceId: "00000000-0000-4000-8000-000000000000",
    name: "Still D",
    bytes: Buffer.alloc(2097152, 42),
  };
  const copied = copyDiskBoxView(source);
  source.slots[3].bytes.fill(9);
  assert.equal(copied.slots[0], null);
  assert.equal(copied.slots[3].instanceId, source.slots[3].instanceId);
  assert.equal(copied.slots[3].bytes[0], 42);
  assert(!sameDiskBoxView(source, copied));
});
test("view validation rejects accessors and unknown fields", () => {
  let read = false;
  const source = view();
  Object.defineProperty(source.slots, "1", {
    get() {
      read = true;
      return null;
    },
    enumerable: true,
  });
  assert.throws(() => copyDiskBoxView(source), /view slot/);
  assert.equal(read, false);
  const other = view();
  other.extra = true;
  assert.throws(() => copyDiskBoxView(other), /view fields/);
});

test("staged new C/P disks are writable without unprotecting retained source IDs", () => {
  const current = view(4);
  current.slots[0] = {
    instanceId: "00000000-0000-4000-8000-000000000001",
    name: "Protected A",
    bytes: new Uint8Array(2097152),
  };
  const configuration = { slots: [{ kind: "published" }, null, null, null] };
  const candidate = view(16);
  candidate.slots[0] = current.slots[0];
  for (const index of [2, 15]) {
    candidate.slots[index] = {
      instanceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      name: "New blank",
      bytes: new Uint8Array(2097152),
    };
    assert(diskBoxViewSlotWritable(configuration, current, candidate, index));
  }
  assert(!diskBoxViewSlotWritable(configuration, current, candidate, 0));
  candidate.slots[15] = current.slots[0];
  assert(!diskBoxViewSlotWritable(configuration, current, candidate, 15));
});
