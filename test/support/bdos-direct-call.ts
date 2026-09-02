import { createHash } from "node:crypto";

import { createDebug80TestHarness } from "./debug80-runtime.js";
import {
  BdosBiosDiskDouble,
  type BdosBiosDiskFixture,
  type BdosBiosDiskSnapshot,
} from "./bdos-bios-double.js";

const MEMORY_BYTES = 0x10000;
const CALLER_ADDRESS = 0x0100;
const BDOS_VECTOR = 0x0005;
const BDOS_BASE = 0xec00;
const BDOS_ENTRY = 0xec06;
const BDOS_LIMIT = 0xfa00;
const BIOS_BASE = 0xfa00;
const BIOS_ENTRIES = 17;
const BIOS_STUB_BASE = 0xfb00;

const BIOS_NAMES = [
  "cold-boot",
  "warm-boot",
  "console-status",
  "console-input",
  "console-output",
  "list-output",
  "punch-output",
  "reader-input",
  "home",
  "select-disk",
  "set-track",
  "set-sector",
  "set-dma",
  "read-sector",
  "write-sector",
  "list-status",
  "sector-translate",
] as const;

export interface BdosDirectCallFixture {
  schema: "triptych-bdos-direct-call-v1";
  id: string;
  evidence: Array<{
    kind: "published-interface" | "black-box-compatibility";
    source: string;
    section: string;
  }>;
  call: {
    function: number;
    de: number;
    stackPointer: number;
  };
  initialMemory?: BdosMemoryPatch[];
  biosDisk?: BdosBiosDiskFixture;
  biosResponses: Array<{
    entry: number;
    occurrence: number;
    action?: "return" | "stop";
    return?: {
      a?: number;
      bc?: number;
      hl?: number;
    };
  }>;
  expected: {
    stop?: "normal-return" | "bios-transfer";
    biosTransferEntry?: number;
    returnRegisters?: Partial<BdosObservedRegisters>;
    memory?: BdosMemoryPatch[];
    biosCalls?: Array<{
      entry: number;
      name: string;
      registers?: Partial<BdosObservedRegisters>;
    }>;
    biosCallCount?: number;
    biosTraceSha256?: string;
    biosDiskState?: Partial<
      Pick<BdosBiosDiskSnapshot, "selectedDrive" | "track" | "sector" | "dma">
    >;
    biosDiskWriteCount?: number;
    biosDiskRecords?: Array<
      BdosBytePattern & {
        drive: number;
        record: number;
      }
    >;
  };
}

export interface BdosBytePattern {
  bytes?: number[];
  length?: number;
  fill?: number;
  patches?: Array<{
    offset: number;
    bytes: number[];
  }>;
}

export interface BdosMemoryPatch extends BdosBytePattern {
  address: number;
}

export interface BdosObservedRegisters {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  h: number;
  l: number;
  sp: number;
  pc: number;
}

export interface BdosBiosCall {
  entry: number;
  name: string;
  occurrence: number;
  registers: BdosObservedRegisters;
}

function biosCallArguments(call: BdosBiosCall): string {
  const { registers } = call;
  if ([4, 5, 6].includes(call.entry)) return `c=${registers.c}`;
  if (call.entry === 9) return `c=${registers.c},e=${registers.e}`;
  if ([10, 11, 12].includes(call.entry)) {
    return `bc=${(registers.b << 8) | registers.c}`;
  }
  if (call.entry === 16) {
    return `bc=${(registers.b << 8) | registers.c},de=${(registers.d << 8) | registers.e}`;
  }
  return "";
}

export function bdosBiosTraceSha256(calls: BdosBiosCall[]): string {
  const canonical = calls
    .map(
      (call) =>
        `${call.entry}:${call.name}:${call.occurrence}:${biosCallArguments(call)}`,
    )
    .join("\n");
  return createHash("sha256").update(`${canonical}\n`, "utf8").digest("hex");
}

export interface BdosDirectCallResult {
  stop: "normal-return" | "bios-transfer";
  biosTransferEntry?: number;
  registers: BdosObservedRegisters;
  biosCalls: BdosBiosCall[];
  changedAddresses: number[];
  memory: Uint8Array;
  biosDisk?: BdosBiosDiskSnapshot;
  biosOwnedWritableAddresses: number[];
  biosMemoryWrittenAddresses: number[];
  steps: number;
  tStates: number;
}

export type BdosDirectCallStep = Omit<BdosDirectCallFixture, "schema">;

export interface BdosDirectCallSequenceFixture {
  schema: "triptych-bdos-direct-sequence-v1";
  id: string;
  description: string;
  biosDisk?: BdosBiosDiskFixture;
  steps: BdosDirectCallStep[];
}

export interface BdosDirectCallSequenceResult {
  id: string;
  steps: Array<{
    id: string;
    result: BdosDirectCallResult;
  }>;
}

function assertByte(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new Error(`${label} must be a byte`);
  }
}

export function materializeBdosBytePattern(
  pattern: BdosBytePattern,
  label = "byte pattern",
): Uint8Array {
  if (
    pattern.length !== undefined &&
    (!Number.isInteger(pattern.length) || pattern.length < 0)
  ) {
    throw new Error(`${label} length must be a non-negative integer`);
  }
  if (pattern.fill !== undefined) assertByte(pattern.fill, `${label} fill`);
  pattern.bytes?.forEach((value) => assertByte(value, `${label} byte`));
  const hasBytes = pattern.bytes !== undefined;
  const hasFilledLength =
    pattern.length !== undefined && pattern.fill !== undefined;
  if (hasBytes === hasFilledLength) {
    throw new Error(
      `${label} must define exactly one of bytes and length with fill`,
    );
  }
  const bytes = hasBytes
    ? Uint8Array.from(pattern.bytes ?? [])
    : new Uint8Array(pattern.length ?? 0).fill(pattern.fill ?? 0);
  for (const nested of pattern.patches ?? []) {
    nested.bytes.forEach((value) => assertByte(value, `${label} patch byte`));
    if (
      !Number.isInteger(nested.offset) ||
      nested.offset < 0 ||
      nested.offset + nested.bytes.length > bytes.length
    ) {
      throw new Error(`${label} nested patch is out of range`);
    }
    bytes.set(nested.bytes, nested.offset);
  }
  return bytes;
}

export function materializeBdosMemoryPatch(patch: BdosMemoryPatch): Uint8Array {
  if (!Number.isInteger(patch.address) || patch.address < 0) {
    throw new Error("memory patch address must be a non-negative integer");
  }
  return materializeBdosBytePattern(patch, "memory patch");
}

function observedRegisters(
  state: ReturnType<
    ReturnType<typeof createDebug80TestHarness>["captureCpuState"]
  >,
): BdosObservedRegisters {
  return {
    a: state.a,
    b: state.b,
    c: state.c,
    d: state.d,
    e: state.e,
    h: state.h,
    l: state.l,
    sp: state.sp,
    pc: state.pc,
  };
}

function applyBiosReturn(
  fixture: BdosDirectCallFixture,
  entry: number,
  occurrence: number,
  state: ReturnType<
    ReturnType<typeof createDebug80TestHarness>["captureCpuState"]
  >,
): void {
  const response = fixture.biosResponses.find(
    (candidate) =>
      candidate.entry === entry && candidate.occurrence === occurrence,
  );
  const returned = response?.return;
  if (returned?.a !== undefined) state.a = returned.a & 0xff;
  if (returned?.bc !== undefined) {
    state.b = (returned.bc >>> 8) & 0xff;
    state.c = returned.bc & 0xff;
  }
  if (returned?.hl !== undefined) {
    state.h = (returned.hl >>> 8) & 0xff;
    state.l = returned.hl & 0xff;
  }
}

function createBdosDirectRunner(
  bdos: Uint8Array,
  biosDiskFixture?: BdosBiosDiskFixture,
): (fixture: BdosDirectCallFixture) => BdosDirectCallResult {
  if (bdos.length !== BDOS_LIMIT - BDOS_BASE) {
    throw new Error(
      `BDOS must fill the fixed ${BDOS_LIMIT - BDOS_BASE}-byte resident slot`,
    );
  }

  const harness = createDebug80TestHarness();
  harness.createRuntime({});
  const runtime = harness.runtime();
  const memory = runtime.hardware.memory;
  memory.fill(0);
  memory.set(bdos, BDOS_BASE);
  memory.set([0xc3, BDOS_ENTRY & 0xff, BDOS_ENTRY >>> 8], BDOS_VECTOR);
  memory.set([0xcd, BDOS_VECTOR, 0x00, 0x76], CALLER_ADDRESS);

  for (let entry = 0; entry < BIOS_ENTRIES; entry += 1) {
    const vectorAddress = BIOS_BASE + entry * 3;
    const stubAddress = BIOS_STUB_BASE + entry;
    memory.set(
      [0xc3, stubAddress & 0xff, (stubAddress >>> 8) & 0xff],
      vectorAddress,
    );
    memory[stubAddress] = 0xc9;
  }
  const biosDisk =
    biosDiskFixture === undefined
      ? undefined
      : new BdosBiosDiskDouble(biosDiskFixture, memory);

  return (fixture: BdosDirectCallFixture): BdosDirectCallResult => {
    biosDisk?.beginCall();
    for (const patch of fixture.initialMemory ?? []) {
      const bytes = materializeBdosMemoryPatch(patch);
      if (patch.address < 0 || patch.address + bytes.length > MEMORY_BYTES) {
        throw new Error(`${fixture.id} initial memory patch is out of range`);
      }
      memory.set(bytes, patch.address);
    }

    const initialMemory = memory.slice();
    const initialState = runtime.captureCpuState();
    initialState.a = 0x99;
    initialState.b = 0x88;
    initialState.c = fixture.call.function & 0xff;
    initialState.d = (fixture.call.de >>> 8) & 0xff;
    initialState.e = fixture.call.de & 0xff;
    initialState.h = 0x77;
    initialState.l = 0x66;
    initialState.pc = CALLER_ADDRESS;
    initialState.sp = fixture.call.stackPointer & 0xffff;
    initialState.halted = false;
    runtime.restoreCpuState(initialState);

    const biosCalls: BdosBiosCall[] = [];
    const occurrences = new Uint16Array(BIOS_ENTRIES);
    let stop: BdosDirectCallResult["stop"] = "normal-return";
    let biosTransferEntry: number | undefined;
    let steps = 0;
    let tStates = 0;
    for (; steps < 100_000 && !runtime.isHalted(); steps += 1) {
      const pc = runtime.getPC();
      if (pc >= BIOS_STUB_BASE && pc < BIOS_STUB_BASE + BIOS_ENTRIES) {
        const entry = pc - BIOS_STUB_BASE;
        const occurrence = occurrences[entry] ?? 0;
        const state = runtime.captureCpuState();
        biosCalls.push({
          entry,
          name: BIOS_NAMES[entry] ?? `unknown-${entry}`,
          occurrence,
          registers: observedRegisters(state),
        });
        const response = fixture.biosResponses.find(
          (candidate) =>
            candidate.entry === entry && candidate.occurrence === occurrence,
        );
        occurrences[entry] = occurrence + 1;
        if (response?.action === "stop") {
          stop = "bios-transfer";
          biosTransferEntry = entry;
          break;
        }
        // An explicit response replaces the semantic disk operation. This lets
        // fixtures inject a failed BIOS read or write without first committing
        // the successful side effect that the response is meant to replace.
        if (response === undefined) biosDisk?.handle(entry, state);
        applyBiosReturn(fixture, entry, occurrence, state);
        runtime.restoreCpuState(state);
      }
      tStates += runtime.step().cycles ?? 0;
    }
    if (!runtime.isHalted() && stop === "normal-return") {
      throw new Error(`${fixture.id} exceeded the direct-call step limit`);
    }
    for (const response of fixture.biosResponses) {
      const calls = occurrences[response.entry] ?? 0;
      if (calls <= response.occurrence) {
        throw new Error(
          `${fixture.id} did not make scripted BIOS call ${response.entry} occurrence ${response.occurrence}`,
        );
      }
    }

    const changedAddresses = [];
    for (let address = 0; address < MEMORY_BYTES; address += 1) {
      if (memory[address] !== initialMemory[address])
        changedAddresses.push(address);
    }
    return {
      stop,
      ...(biosTransferEntry === undefined ? {} : { biosTransferEntry }),
      registers: observedRegisters(runtime.captureCpuState()),
      biosCalls,
      changedAddresses,
      memory: memory.slice(),
      ...(biosDisk === undefined ? {} : { biosDisk: biosDisk.snapshot() }),
      biosOwnedWritableAddresses: [...(biosDisk?.ownedWritableAddresses ?? [])],
      biosMemoryWrittenAddresses: [...(biosDisk?.memoryWrittenAddresses ?? [])],
      steps,
      tStates,
    };
  };
}

export function runBdosDirectCall(
  bdos: Uint8Array,
  fixture: BdosDirectCallFixture,
): BdosDirectCallResult {
  return createBdosDirectRunner(bdos, fixture.biosDisk)(fixture);
}

export function runBdosDirectCallSequence(
  bdos: Uint8Array,
  fixture: BdosDirectCallSequenceFixture,
): BdosDirectCallSequenceResult {
  const run = createBdosDirectRunner(bdos, fixture.biosDisk);
  return {
    id: fixture.id,
    steps: fixture.steps.map((step) => ({
      id: step.id,
      result: run({ schema: "triptych-bdos-direct-call-v1", ...step }),
    })),
  };
}

export function unexpectedDirectCallWrites(
  result: BdosDirectCallResult,
  stackPointer: number,
  allowedAddresses: ReadonlySet<number> = new Set(),
): number[] {
  const callStackFirst = (stackPointer - 2) & 0xffff;
  const callStackLast = (stackPointer - 1) & 0xffff;
  return result.changedAddresses.filter(
    (address) =>
      !(address >= BDOS_BASE && address < BDOS_LIMIT) &&
      !(address >= callStackFirst && address <= callStackLast) &&
      !result.biosOwnedWritableAddresses.includes(address) &&
      !result.biosMemoryWrittenAddresses.includes(address) &&
      !allowedAddresses.has(address),
  );
}
