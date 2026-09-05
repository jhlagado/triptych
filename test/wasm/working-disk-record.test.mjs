import { describe, expect, it } from "vitest";
import {
  validateWorkingDiskRecord,
  WORKING_DISK_SCHEMA,
} from "../../crates/triptych-host-wasm/web/working-disk-store.js";

describe("legacy working-disk record decoding", () => {
  const valid = () => ({
    schema: WORKING_DISK_SCHEMA,
    key: "drive-a",
    name: "work.img",
    bytes: new Uint8Array(512),
  });
  it("validates and copies stored bytes", () => {
    const value = valid();
    const result = validateWorkingDiskRecord(value);
    value.bytes[0] = 99;
    expect(result.bytes[0]).toBe(0);
  });
  it.each([
    { schema: "old" },
    { key: "other" },
    { name: "" },
    { bytes: new Uint8Array(511) },
  ])("rejects invalid stored fields %j", (bad) => {
    expect(() => validateWorkingDiskRecord({ ...valid(), ...bad })).toThrow();
  });
});
