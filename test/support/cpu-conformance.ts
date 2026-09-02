import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { CpuStateSnapshot } from "@jhlagado/debug80-runtime/z80/runtime";

import { createEsp32SbcRuntime } from "../../src/cpu/runtime.js";
import type {
  CreateZ80HostRuntime,
  Z80IoHandlers,
} from "../../src/shared/z80.js";
import { createDebug80TestHarness } from "./debug80-runtime.js";

const FIXTURE_FORMAT = "triptych.cpu.conformance.fixture.v1";
const RESULT_FORMAT = "triptych.cpu.conformance.result.v1";

const CPU_FIELDS = [
  "a",
  "a_prime",
  "b",
  "b_prime",
  "c",
  "c_prime",
  "d",
  "d_prime",
  "e",
  "e_prime",
  "f.c",
  "f.h",
  "f.n",
  "f.p",
  "f.s",
  "f.x",
  "f.y",
  "f.z",
  "f_prime.c",
  "f_prime.h",
  "f_prime.n",
  "f_prime.p",
  "f_prime.s",
  "f_prime.x",
  "f_prime.y",
  "f_prime.z",
  "h",
  "h_prime",
  "halted",
  "i",
  "iff1",
  "iff2",
  "imode",
  "ix",
  "iy",
  "l",
  "l_prime",
  "pc",
  "r",
  "sp",
] as const;

export type CpuObservation = (typeof CPU_FIELDS)[number];

interface BytePatch {
  address: number;
  bytes: number[];
}

interface ByteImage {
  size: number;
  fill: number;
  patches: BytePatch[];
}

interface RamObservation {
  address: number;
  length: number;
}

interface ScheduledInterrupt {
  afterStep: number;
  kind: "maskable" | "nmi";
  data: number;
}

export interface ConformanceIoOperation {
  direction: "read" | "write";
  port: number;
  value: number;
}

export interface ConformanceResult {
  format: typeof RESULT_FORMAT;
  fixture: string;
  stop: "halt" | "step-limit" | "tstate-limit";
  steps: number;
  tStates: number;
  cpu: Record<string, number | boolean>;
  bootRomEnabled: boolean;
  ramSha256: string;
  ram: Array<{ address: number; bytes: number[] }>;
  driveSha256: string[];
  serialOutput: number[];
  io: ConformanceIoOperation[];
}

export interface CpuConformanceFixture {
  format: typeof FIXTURE_FORMAT;
  id: string;
  description: string;
  initial: {
    bootRom: ByteImage;
    ram: ByteImage;
    drives: ByteImage[];
    serialInput: number[];
    cpu: Partial<Record<CpuObservation, number | boolean>>;
  };
  run: {
    maxSteps: number;
    maxTStates: number;
    interrupts: ScheduledInterrupt[];
  };
  observe: {
    cpu: CpuObservation[];
    ram: RamObservation[];
  };
  expected: {
    result: ConformanceResult;
    digest: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${path} must be a string`);
  }
  return value;
}

function expectInteger(
  value: unknown,
  path: string,
  minimum = 0,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new RangeError(
      `${path} must be an integer from ${minimum} through ${maximum}`,
    );
  }
  return value as number;
}

function expectByteArray(value: unknown, path: string): number[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${path} must be an array`);
  }
  return value.map((byte, index) =>
    expectInteger(byte, `${path}[${index}]`, 0, 0xff),
  );
}

function parseImage(value: unknown, path: string): ByteImage {
  const record = expectRecord(value, path);
  const patchesValue = record.patches;
  if (!Array.isArray(patchesValue)) {
    throw new TypeError(`${path}.patches must be an array`);
  }
  const patches = patchesValue.map((patchValue, index): BytePatch => {
    const patch = expectRecord(patchValue, `${path}.patches[${index}]`);
    return {
      address: expectInteger(
        patch.address,
        `${path}.patches[${index}].address`,
        0,
        0xffff_ffff,
      ),
      bytes: expectByteArray(patch.bytes, `${path}.patches[${index}].bytes`),
    };
  });
  const image = {
    size: expectInteger(record.size, `${path}.size`, 1, 0xffff_ffff),
    fill: expectInteger(record.fill, `${path}.fill`, 0, 0xff),
    patches,
  };
  for (const [index, patch] of image.patches.entries()) {
    if (patch.address + patch.bytes.length > image.size) {
      throw new RangeError(`${path}.patches[${index}] exceeds the image`);
    }
  }
  return image;
}

function parseCpuObservations(value: unknown): CpuObservation[] {
  if (!Array.isArray(value)) {
    throw new TypeError("observe.cpu must be an array");
  }
  const allowed = new Set<string>(CPU_FIELDS);
  const fields = value.map((field, index) => {
    const name = expectString(field, `observe.cpu[${index}]`);
    if (!allowed.has(name)) {
      throw new RangeError(`observe.cpu[${index}] is not a v1 CPU field`);
    }
    return name as CpuObservation;
  });
  if (new Set(fields).size !== fields.length) {
    throw new RangeError("observe.cpu must not contain duplicate fields");
  }
  return fields.sort();
}

function parseRamObservations(value: unknown): RamObservation[] {
  if (!Array.isArray(value)) {
    throw new TypeError("observe.ram must be an array");
  }
  const observations = value.map((item, index): RamObservation => {
    const observation = expectRecord(item, `observe.ram[${index}]`);
    const address = expectInteger(
      observation.address,
      `observe.ram[${index}].address`,
      0,
      0xffff,
    );
    const length = expectInteger(
      observation.length,
      `observe.ram[${index}].length`,
      1,
      0x10000,
    );
    if (address + length > 0x10000) {
      throw new RangeError(`observe.ram[${index}] exceeds 64 KiB RAM`);
    }
    return { address, length };
  });
  return observations.sort((left, right) => left.address - right.address);
}

function parseCpuValues(
  value: unknown,
  path: string,
): Partial<Record<CpuObservation, number | boolean>> {
  const record = expectRecord(value, path);
  const allowed = new Set<string>(CPU_FIELDS);
  const parsed: Partial<Record<CpuObservation, number | boolean>> = {};
  for (const [field, fieldValue] of Object.entries(record)) {
    if (!allowed.has(field)) {
      throw new RangeError(`${path}.${field} is not a v1 CPU field`);
    }
    const observation = field as CpuObservation;
    if (observation === "halted") {
      if (typeof fieldValue !== "boolean") {
        throw new TypeError(`${path}.halted must be a boolean`);
      }
      parsed[observation] = fieldValue;
      continue;
    }
    const bitField =
      observation.startsWith("f.") ||
      observation.startsWith("f_prime.") ||
      observation === "iff1" ||
      observation === "iff2";
    const wordField = ["ix", "iy", "sp", "pc"].includes(observation);
    parsed[observation] = expectInteger(
      fieldValue,
      `${path}.${field}`,
      0,
      bitField ? 1 : wordField ? 0xffff : observation === "imode" ? 2 : 0xff,
    );
  }
  return parsed;
}

function parseInterrupts(value: unknown): ScheduledInterrupt[] {
  if (!Array.isArray(value)) {
    throw new TypeError("run.interrupts must be an array");
  }
  const interrupts = value.map((item, index): ScheduledInterrupt => {
    const interrupt = expectRecord(item, `run.interrupts[${index}]`);
    const kind = expectString(interrupt.kind, `run.interrupts[${index}].kind`);
    if (kind !== "maskable" && kind !== "nmi") {
      throw new RangeError(
        `run.interrupts[${index}].kind must be maskable or nmi`,
      );
    }
    return {
      afterStep: expectInteger(
        interrupt.afterStep,
        `run.interrupts[${index}].afterStep`,
        1,
      ),
      kind,
      data: expectInteger(
        interrupt.data,
        `run.interrupts[${index}].data`,
        0,
        0xff,
      ),
    };
  });
  interrupts.sort((left, right) => left.afterStep - right.afterStep);
  if (
    interrupts.some(
      (interrupt, index) =>
        index > 0 && interrupt.afterStep === interrupts[index - 1]?.afterStep,
    )
  ) {
    throw new RangeError("run.interrupts must not share an afterStep value");
  }
  return interrupts;
}

export function loadCpuConformanceFixture(
  fixtureUrl: URL,
): CpuConformanceFixture {
  const root = expectRecord(
    JSON.parse(readFileSync(fixtureUrl, "utf8")) as unknown,
    "fixture",
  );
  if (root.format !== FIXTURE_FORMAT) {
    throw new RangeError(`fixture.format must be ${FIXTURE_FORMAT}`);
  }
  const id = expectString(root.id, "fixture.id");
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new RangeError("fixture.id must match [a-z0-9-]+");
  }
  const initial = expectRecord(root.initial, "initial");
  const drivesValue = initial.drives;
  if (!Array.isArray(drivesValue)) {
    throw new TypeError("initial.drives must be an array");
  }
  const bootRom = parseImage(initial.bootRom, "initial.bootRom");
  const ram = parseImage(initial.ram, "initial.ram");
  const drives = drivesValue.map((drive, index) =>
    parseImage(drive, `initial.drives[${index}]`),
  );
  if (bootRom.size !== 0x100) {
    throw new RangeError("initial.bootRom.size must be 256");
  }
  if (ram.size !== 0x10000) {
    throw new RangeError("initial.ram.size must be 65536");
  }
  for (const [index, drive] of drives.entries()) {
    if (drive.size % 512 !== 0) {
      throw new RangeError(`initial.drives[${index}].size must divide by 512`);
    }
  }
  const run = expectRecord(root.run, "run");
  const observe = expectRecord(root.observe, "observe");

  // The expected result is retained verbatim after checking its outer shape;
  // Vitest's structural comparison provides the field-level discriminator.
  const expected = expectRecord(root.expected, "expected");
  const expectedResult = expectRecord(expected.result, "expected.result");

  return {
    format: FIXTURE_FORMAT,
    id,
    description: expectString(root.description, "fixture.description"),
    initial: {
      bootRom,
      ram,
      drives,
      serialInput: expectByteArray(initial.serialInput, "initial.serialInput"),
      cpu: parseCpuValues(initial.cpu, "initial.cpu"),
    },
    run: {
      maxSteps: expectInteger(run.maxSteps, "run.maxSteps", 1),
      maxTStates: expectInteger(run.maxTStates, "run.maxTStates", 1),
      interrupts: parseInterrupts(run.interrupts),
    },
    observe: {
      cpu: parseCpuObservations(observe.cpu),
      ram: parseRamObservations(observe.ram),
    },
    expected: {
      result: expectedResult as unknown as ConformanceResult,
      digest: expectString(expected.digest, "expected.digest"),
    },
  };
}

function materializeImage(specification: ByteImage): Uint8Array {
  const image = new Uint8Array(specification.size).fill(specification.fill);
  for (const patch of specification.patches) {
    image.set(patch.bytes, patch.address);
  }
  return image;
}

function cpuField(
  snapshot: CpuStateSnapshot,
  field: CpuObservation,
): number | boolean {
  if (field.startsWith("f_prime.")) {
    const name = field
      .slice("f_prime.".length)
      .toUpperCase() as keyof typeof snapshot.flags_prime;
    return snapshot.flags_prime[name];
  }
  if (field.startsWith("f.")) {
    const name = field
      .slice("f.".length)
      .toUpperCase() as keyof typeof snapshot.flags;
    return snapshot.flags[name];
  }
  return snapshot[field as keyof CpuStateSnapshot] as number | boolean;
}

function setCpuField(
  snapshot: CpuStateSnapshot,
  field: CpuObservation,
  value: number | boolean,
): void {
  if (field.startsWith("f_prime.")) {
    const name = field
      .slice("f_prime.".length)
      .toUpperCase() as keyof typeof snapshot.flags_prime;
    snapshot.flags_prime[name] = value as number;
    return;
  }
  if (field.startsWith("f.")) {
    const name = field
      .slice("f.".length)
      .toUpperCase() as keyof typeof snapshot.flags;
    snapshot.flags[name] = value as number;
    return;
  }
  const mutable = snapshot as unknown as Record<string, number | boolean>;
  mutable[field] = value;
}

function captureCpu(
  snapshot: CpuStateSnapshot,
  fields: readonly CpuObservation[],
): Record<string, number | boolean> {
  return Object.fromEntries(
    fields.map((field) => [field, cpuField(snapshot, field)]),
  );
}

export function runCpuConformanceFixture(
  fixture: CpuConformanceFixture,
): ConformanceResult {
  const transcript: ConformanceIoOperation[] = [];
  let completedStep = 0;
  const interrupts = new Map(
    fixture.run.interrupts.map((interrupt) => [interrupt.afterStep, interrupt]),
  );
  const harness = createDebug80TestHarness({
    tick: () => {
      completedStep += 1;
      const interrupt = interrupts.get(completedStep);
      if (interrupt === undefined) {
        return undefined;
      }
      return {
        interrupt: {
          nonMaskable: interrupt.kind === "nmi",
          data: interrupt.data,
        },
      };
    },
  });
  const createRuntime: CreateZ80HostRuntime = (handlers: Z80IoHandlers) =>
    harness.createRuntime({
      read: (port: number): number => {
        const value = handlers.read?.(port) ?? 0;
        transcript.push({ direction: "read", port: port & 0xffff, value });
        return value;
      },
      write: (port: number, value: number): void => {
        transcript.push({
          direction: "write",
          port: port & 0xffff,
          value: value & 0xff,
        });
        handlers.write?.(port, value);
      },
    });

  const machine = createEsp32SbcRuntime({
    bootRom: materializeImage(fixture.initial.bootRom),
    drives: fixture.initial.drives.map((drive) => ({
      image: materializeImage(drive),
    })),
    createZ80Runtime: createRuntime,
  });
  machine.z80.hardware.memory.set(materializeImage(fixture.initial.ram));
  const preResetCpu = harness.captureCpuState();
  for (const [field, value] of Object.entries(fixture.initial.cpu)) {
    setCpuField(preResetCpu, field as CpuObservation, value);
  }
  harness.runtime().restoreCpuState(preResetCpu);
  machine.reset();
  machine.serial.enqueueInput(fixture.initial.serialInput);

  let steps = 0;
  let tStates = 0;
  let stop: ConformanceResult["stop"] = "step-limit";
  while (steps < fixture.run.maxSteps) {
    const step = machine.z80.step();
    const cycles = step.cycles;
    if (cycles === undefined) {
      throw new Error("Z80 provider did not report instruction T-states");
    }
    steps += 1;
    tStates += cycles;
    if (machine.z80.isHalted()) {
      stop = "halt";
      break;
    }
    if (tStates >= fixture.run.maxTStates) {
      stop = "tstate-limit";
      break;
    }
  }

  const ram = machine.z80.hardware.memory;
  const driveSha256 = machine.disk
    .exportPersistentImages()
    .map((image) => createHash("sha256").update(image).digest("hex"));
  return {
    format: RESULT_FORMAT,
    fixture: fixture.id,
    stop,
    steps,
    tStates,
    cpu: captureCpu(harness.captureCpuState(), fixture.observe.cpu),
    bootRomEnabled: machine.memory.snapshot().bootRomEnabled,
    ramSha256: createHash("sha256").update(ram).digest("hex"),
    ram: fixture.observe.ram.map(({ address, length }) => ({
      address,
      bytes: Array.from(ram.slice(address, address + length)),
    })),
    driveSha256,
    serialOutput: machine.serial.drainOutput(),
    io: transcript,
  };
}

function hex(value: number, width: number): string {
  return value.toString(16).padStart(width, "0");
}

function bytesHex(bytes: readonly number[]): string {
  return bytes.map((byte) => hex(byte, 2)).join("");
}

export function canonicalCpuConformanceTranscript(
  result: ConformanceResult,
): string {
  const lines = [
    "triptych-cpu-result-v1",
    `fixture=${result.fixture}`,
    `stop=${result.stop}`,
    `steps=${result.steps}`,
    `tstates=${result.tStates}`,
    `boot-rom-enabled=${result.bootRomEnabled ? 1 : 0}`,
  ];
  for (const field of Object.keys(result.cpu).sort()) {
    const value = result.cpu[field];
    lines.push(
      `cpu.${field}=${typeof value === "boolean" ? (value ? 1 : 0) : value}`,
    );
  }
  lines.push(`ram-sha256=${result.ramSha256}`);
  for (const observation of [...result.ram].sort(
    (left, right) => left.address - right.address,
  )) {
    lines.push(
      `ram.${hex(observation.address, 4)}=${bytesHex(observation.bytes)}`,
    );
  }
  lines.push(`drives=${result.driveSha256.length}`);
  result.driveSha256.forEach((digest, index) => {
    lines.push(`drive.${index}-sha256=${digest}`);
  });
  lines.push(`serial=${bytesHex(result.serialOutput)}`);
  result.io.forEach((operation, index) => {
    lines.push(
      `io.${index}=${operation.direction === "read" ? "r" : "w"},${hex(operation.port, 4)},${hex(operation.value, 2)}`,
    );
  });
  return `${lines.join("\n")}\n`;
}

export function digestCpuConformanceResult(result: ConformanceResult): string {
  return createHash("sha256")
    .update(canonicalCpuConformanceTranscript(result), "utf8")
    .digest("hex");
}
