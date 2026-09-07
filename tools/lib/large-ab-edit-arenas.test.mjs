import assert from "node:assert/strict";
import { test } from "node:test";
import { createSuite } from "./large-ab-edit-arenas.mjs";

function machine(text, gapStart) {
  const memory = Buffer.alloc(65536, 0xa5);
  const gapEnd = gapStart + 0xb800 - text.length;
  memory.writeUInt16LE(text.length, 0x1ec8);
  memory.writeUInt16LE(gapStart, 0x1f4a);
  memory.writeUInt16LE(gapEnd, 0x1f4c);
  memory[0x1ed4] = 0;
  text.copy(memory, 0x2000, 0, gapStart);
  text.copy(memory, 0x2000 + gapEnd, gapStart);
  return {
    memory,
    read_ram: (address, length) => memory.subarray(address, address + length),
  };
}

test("Edit arena observer reads both occupied spans and rejects corrupt bounds or suffix", () => {
  const suite = createSuite();
  const step = suite.steps.find((s) => s.id === "edit-query-open");
  const text = suite.fixtures.get("QUERY.TXT");
  for (const split of [0, 17, text.length])
    step.checkMemory(machine(text, split));
  const badSuffix = machine(text, 17);
  badSuffix.memory[0xd7ff] ^= 1;
  assert.throws(() => step.checkMemory(badSuffix), /logical text/);
  const badGap = machine(text, 17);
  badGap.memory.writeUInt16LE(0xb801, 0x1f4c);
  assert.throws(() => step.checkMemory(badGap), /gap bounds/);
  const badLength = machine(text, 17);
  badLength.memory.writeUInt16LE(text.length + 1, 0x1ec8);
  assert.throws(() => step.checkMemory(badLength), /length agrees/);
});

test("rejected full-capacity growth preserves physical arena and zero-gap position", () => {
  const suite = createSuite();
  const accepted = suite.steps.find((s) => s.id === "edit-grow-exact");
  const rejected = suite.steps.find((s) => s.id === "edit-grow-over");
  const text = Buffer.from("QQ" + "A".repeat(47102));
  const cpu = machine(text, 2);
  cpu.memory[0x1ed4] = 1;
  cpu.memory[0x1ed5] = 81;
  accepted.checkMemory(cpu);
  rejected.checkMemory(cpu);
  // A zero-sized gap can move without changing logical text; rejection cannot.
  cpu.memory.writeUInt16LE(3, 0x1f4a);
  cpu.memory.writeUInt16LE(3, 0x1f4c);
  assert.throws(
    () => rejected.checkMemory(cpu),
    /preserves persistent editor state/,
  );
  cpu.memory.writeUInt16LE(2, 0x1f4a);
  cpu.memory.writeUInt16LE(2, 0x1f4c);
  cpu.memory[0xd7ff] ^= 1;
  assert.throws(() => rejected.checkMemory(cpu), /logical text/);
});
