import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assembleAtomFile } from "../tools/lib/assemble-atom.mjs";

describe("ATOM flat-image build boundary", () => {
  let directory: string;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "triptych-atom-test-"));
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  async function assemble(name: string, source: string) {
    const file = join(directory, name);
    await writeFile(file, source);
    return assembleAtomFile(file);
  }

  it("resolves forward patches and retains absolute labels, excluding equates", async () => {
    const result = await assemble(
      "forward.asm",
      "ORG $EC00\nVALUE EQU 42\nSTART: LD HL,END\nJR END\nDB VALUE\nEND: RET\n",
    );
    expect(result.base).toBe(0xec00);
    expect([...result.bytes]).toEqual([0x21, 0x06, 0xec, 0x18, 1, 42, 0xc9]);
    expect(result.labels).toEqual({ START: 0xec00, END: 0xec06 });
  });

  it("zero-fills ORG gaps and trailing uninitialised storage", async () => {
    const result = await assemble(
      "gaps.asm",
      "ORG $100\nDB 7\nORG $104\nDB 8\nDS 2\nEND:\n",
    );
    expect(result.base).toBe(0x100);
    expect([...result.bytes]).toEqual([7, 0, 0, 0, 8, 0, 0]);
    expect(result.labels.END).toBe(0x107);
  });

  it("retains a zero-based bootstrap", async () => {
    const result = await assemble("zero.asm", "ORG 0\nJP $FA00\nDS 5,0\n");
    expect(result.base).toBe(0);
    expect([...result.bytes]).toEqual([0xc3, 0, 0xfa, 0, 0, 0, 0, 0]);
  });

  it("rejects unresolved symbols instead of publishing partial bytes", async () => {
    await expect(
      assemble("bad.asm", "ORG $100\nJP MISSING\n"),
    ).rejects.toThrow();
  });

  it("rejects long symbols rather than falling back to another assembler", async () => {
    await expect(
      assemble("long.asm", "ORG $100\nLONGSYMBOL: RET\n"),
    ).rejects.toThrow();
  });

  it("rejects empty output", async () => {
    await expect(assemble("empty.asm", "; no output\n")).rejects.toThrow();
  });

  it("rejects missing source", async () => {
    await expect(
      assembleAtomFile(join(directory, "missing.asm")),
    ).rejects.toThrow();
  });
});
