import { describe, expect, it } from "vitest";

import { WorkingDiskPersistence } from "../../crates/triptych-host-wasm/web/working-disk-persistence.js";
import {
  validateWorkingDiskRecord,
  WORKING_DISK_SCHEMA,
} from "../../crates/triptych-host-wasm/web/working-disk-store.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("browser working-disk persistence", () => {
  it("validates and copies stored bytes", () => {
    const original = Uint8Array.from({ length: 512 }, (_, index) => index);
    const record = validateWorkingDiskRecord({
      schema: WORKING_DISK_SCHEMA,
      key: "drive-a",
      name: "work.img",
      bytes: original,
    });
    original[0] = 99;
    expect(record.bytes[0]).toBe(0);
  });

  it.each([
    {
      schema: "old",
      key: "drive-a",
      name: "work.img",
      bytes: new Uint8Array(512),
    },
    {
      schema: WORKING_DISK_SCHEMA,
      key: "other",
      name: "work.img",
      bytes: new Uint8Array(512),
    },
    {
      schema: WORKING_DISK_SCHEMA,
      key: "drive-a",
      name: "",
      bytes: new Uint8Array(512),
    },
    {
      schema: WORKING_DISK_SCHEMA,
      key: "drive-a",
      name: "work.img",
      bytes: new Uint8Array(511),
    },
  ])("rejects an invalid stored record", (record) => {
    expect(() => validateWorkingDiskRecord(record)).toThrow();
  });

  it("restores a saved disk and reports the state transition", async () => {
    const states = [];
    const saved = { name: "work.img", bytes: new Uint8Array(512) };
    const persistence = new WorkingDiskPersistence(
      { load: async () => saved },
      (state) => states.push(state.state),
    );

    expect(await persistence.restore()).toBe(saved);
    expect(states).toEqual(["loading", "restored"]);
  });

  it("persists only flush edges and copies the machine snapshot", async () => {
    const writes = [];
    const persistence = new WorkingDiskPersistence({
      load: async () => undefined,
      save: async (value) => writes.push(value),
    });
    const bytes = new Uint8Array(512);
    persistence.beginMachine(0);

    let exports = 0;
    const exportBytes = () => {
      exports += 1;
      return bytes;
    };
    expect(persistence.observeFlush(0, "work.img", exportBytes)).toBe(false);
    expect(persistence.observeFlush(1, "work.img", exportBytes)).toBe(true);
    bytes[0] = 99;
    await persistence.drain();

    expect(writes).toHaveLength(1);
    expect(writes[0].bytes[0]).toBe(0);
    expect(exports).toBe(1);
  });

  it("coalesces queued states while preserving the newest snapshot", async () => {
    const first = deferred();
    const writes = [];
    const persistence = new WorkingDiskPersistence({
      load: async () => undefined,
      save: async (value) => {
        writes.push(value.bytes[0]);
        if (writes.length === 1) await first.promise;
      },
    });

    persistence.replace("work.img", Uint8Array.of(1));
    await Promise.resolve();
    persistence.replace("work.img", Uint8Array.of(2));
    persistence.replace("work.img", Uint8Array.of(3));
    first.resolve();
    await persistence.drain();

    expect(writes).toEqual([1, 3]);
  });

  it("reports a failed save and accepts a later flush", async () => {
    const states = [];
    let fail = true;
    const writes = [];
    const persistence = new WorkingDiskPersistence(
      {
        load: async () => undefined,
        save: async (value) => {
          if (fail) {
            fail = false;
            throw new Error("quota");
          }
          writes.push(value.bytes[0]);
        },
      },
      (state) => states.push(state.state),
    );

    persistence.beginMachine(0);
    persistence.observeFlush(1, "work.img", () => Uint8Array.of(1));
    await persistence.drain();
    persistence.observeFlush(2, "work.img", () => Uint8Array.of(2));
    await persistence.drain();

    expect(states).toEqual(["saving", "error", "saving", "saved"]);
    expect(writes).toEqual([2]);
  });
});
