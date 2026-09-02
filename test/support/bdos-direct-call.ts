import { createDebug80TestHarness } from "./debug80-runtime.js";

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
  biosResponses: Array<{
    entry: number;
    occurrence: number;
    return?: {
      a?: number;
      bc?: number;
      hl?: number;
    };
  }>;
  expected: {
    returnRegisters?: Partial<BdosObservedRegisters>;
    biosCalls: Array<{
      entry: number;
      name: string;
      registers?: Partial<BdosObservedRegisters>;
    }>;
  };
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

export interface BdosDirectCallResult {
  registers: BdosObservedRegisters;
  biosCalls: BdosBiosCall[];
  changedAddresses: number[];
  steps: number;
  tStates: number;
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

export function runBdosDirectCall(
  bdos: Uint8Array,
  fixture: BdosDirectCallFixture,
): BdosDirectCallResult {
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
      applyBiosReturn(fixture, entry, occurrence, state);
      occurrences[entry] = occurrence + 1;
      runtime.restoreCpuState(state);
    }
    tStates += runtime.step().cycles ?? 0;
  }
  if (!runtime.isHalted()) {
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
    registers: observedRegisters(runtime.captureCpuState()),
    biosCalls,
    changedAddresses,
    steps,
    tStates,
  };
}

export function unexpectedDirectCallWrites(
  result: BdosDirectCallResult,
  stackPointer: number,
): number[] {
  const callStackFirst = (stackPointer - 2) & 0xffff;
  const callStackLast = (stackPointer - 1) & 0xffff;
  return result.changedAddresses.filter(
    (address) =>
      !(address >= BDOS_BASE && address < BDOS_LIMIT) &&
      !(address >= callStackFirst && address <= callStackLast),
  );
}
