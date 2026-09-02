import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { compile, defaultFormatWriters } from "@jhlagado/azm/compile";
import { runCpmHeadlessScenario } from "./lib/cpm-headless-scenario.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const fixtureDirectory = join(
  repositoryRoot,
  "test",
  "conformance",
  "fixtures",
);
const sourceDirectory = join(repositoryRoot, "roms", "cpu");
const headlessScenarioDirectory = join(
  repositoryRoot,
  "test",
  "bdos",
  "scenarios",
);
const require = createRequire(import.meta.url);
const { TriptychCpu } = require(
  join(repositoryRoot, "dist", "wasm", "triptych_host_wasm.js"),
);

const FIXTURE_FORMAT = "triptych.cpu.conformance.fixture.v1";
const RESULT_FORMAT = "triptych.cpu.conformance.result.v1";
const BACKING_SECTOR_BYTES = 512;
const BDOS_SYSTEM_OFFSET = 0x0800;
const BIOS_SYSTEM_OFFSET = 0x1600;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function materialize(image) {
  const bytes = new Uint8Array(image.size).fill(image.fill);
  for (const patch of image.patches) {
    bytes.set(patch.bytes, patch.address);
  }
  return bytes;
}

function cpuField(state, flags, flagsPrime, field) {
  if (field.startsWith("f_prime.")) {
    return Number(flagsPrime[field.slice("f_prime.".length)]());
  }
  if (field.startsWith("f.")) {
    return Number(flags[field.slice("f.".length)]());
  }
  if (field === "halted") return state.halted();
  if (field === "iff1" || field === "iff2") return Number(state[field]());
  return state[field]();
}

function captureCpu(machine, fields) {
  const state = machine.cpu_state();
  const flags = state.flags();
  const flagsPrime = state.flags_prime();
  try {
    return Object.fromEntries(
      [...fields]
        .sort()
        .map((field) => [field, cpuField(state, flags, flagsPrime, field)]),
    );
  } finally {
    flags.free();
    flagsPrime.free();
    state.free();
  }
}

function decodeIo(packed) {
  return Array.from(packed, (operation) => ({
    direction: operation & (1 << 24) ? "write" : "read",
    port: (operation >>> 8) & 0xffff,
    value: operation & 0xff,
  }));
}

function runFixture(fixture) {
  assert.equal(fixture.format, FIXTURE_FORMAT);
  const machine = new TriptychCpu(materialize(fixture.initial.bootRom));
  try {
    fixture.initial.drives.forEach((drive, index) => {
      machine.install_drive(index, materialize(drive), true);
    });
    for (const patch of fixture.initial.ram.patches) {
      machine.write_ram(patch.address, Uint8Array.from(patch.bytes));
    }
    if (fixture.initial.ram.fill !== 0) {
      machine.write_ram(
        0,
        new Uint8Array(fixture.initial.ram.size).fill(fixture.initial.ram.fill),
      );
      for (const patch of fixture.initial.ram.patches) {
        machine.write_ram(patch.address, Uint8Array.from(patch.bytes));
      }
    }
    for (const [field, value] of Object.entries(fixture.initial.cpu)) {
      machine.set_conformance_cpu_field(field, Number(value));
    }
    machine.reset();
    machine.enqueue_serial_input(Uint8Array.from(fixture.initial.serialInput));

    const interrupts = new Map(
      fixture.run.interrupts.map((interrupt) => [
        interrupt.afterStep,
        interrupt,
      ]),
    );
    let steps = 0;
    let tStates = 0;
    let stop = "step-limit";
    while (steps < fixture.run.maxSteps) {
      const nextStep = steps + 1;
      const interrupt = interrupts.get(nextStep);
      if (interrupt) {
        assert.equal(interrupt.kind, "maskable", fixture.id);
        assert.equal(interrupt.data, 0xff, fixture.id);
      }
      tStates += machine.step(interrupt !== undefined);
      steps += 1;
      if (machine.last_halted()) {
        stop = "halt";
        break;
      }
      if (tStates >= fixture.run.maxTStates) {
        stop = "tstate-limit";
        break;
      }
    }

    const ram = machine.ram_image();
    const result = {
      format: RESULT_FORMAT,
      fixture: fixture.id,
      stop,
      steps,
      tStates,
      cpu: captureCpu(machine, fixture.observe.cpu),
      bootRomEnabled: machine.boot_rom_enabled(),
      ramSha256: sha256(ram),
      ram: fixture.observe.ram.map(({ address, length }) => ({
        address,
        bytes: Array.from(ram.slice(address, address + length)),
      })),
      driveSha256: fixture.initial.drives.map((_, index) =>
        sha256(machine.export_drive(index)),
      ),
      serialOutput: Array.from(machine.serial_output()),
      io: decodeIo(machine.take_io_trace()),
    };
    assert.deepEqual(result, fixture.expected.result, `${fixture.id} result`);
    assert.equal(
      sha256(Buffer.from(canonicalTranscript(result), "utf8")),
      fixture.expected.digest,
      `${fixture.id} digest`,
    );
    return fixture.id;
  } finally {
    machine.free();
  }
}

function hex(value, width) {
  return value.toString(16).padStart(width, "0");
}

function bytesHex(bytes) {
  return Array.from(bytes, (byte) => hex(byte, 2)).join("");
}

function canonicalTranscript(result) {
  const lines = [
    "triptych-cpu-result-v1",
    `fixture=${result.fixture}`,
    `stop=${result.stop}`,
    `steps=${result.steps}`,
    `tstates=${result.tStates}`,
    `boot-rom-enabled=${result.bootRomEnabled ? 1 : 0}`,
  ];
  for (const field of Object.keys(result.cpu).sort()) {
    lines.push(`cpu.${field}=${Number(result.cpu[field])}`);
  }
  lines.push(`ram-sha256=${result.ramSha256}`);
  for (const range of [...result.ram].sort(
    (left, right) => left.address - right.address,
  )) {
    lines.push(`ram.${hex(range.address, 4)}=${bytesHex(range.bytes)}`);
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

async function assemble(source) {
  const result = await compile(
    source,
    {
      emitBin: true,
      emitHex: false,
      emitD8m: false,
      emitLst: false,
      emitAsm80: false,
      registerContracts: "off",
      registerContractsInterfaces: [],
    },
    { formats: defaultFormatWriters },
  );
  const errors = result.diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  );
  assert.deepEqual(errors, []);
  const binary = result.artifacts.find((artifact) => artifact.kind === "bin");
  assert.equal(binary?.kind, "bin");
  return binary.bytes;
}

function padForBackingSectors(image) {
  const length =
    Math.ceil(image.length / BACKING_SECTOR_BYTES) * BACKING_SECTOR_BYTES;
  const padded = new Uint8Array(length);
  padded.set(image);
  return padded;
}

async function proveCpm() {
  const cpmImagePath = resolve(
    process.env.TRIPTYCH_CPM22_IMAGE ??
      join(repositoryRoot, "third_party", "cpm22", "cpm22.img"),
  );
  const [bootRom, bdos, bios, sourceDisk] = await Promise.all([
    assemble(join(sourceDirectory, "bootstrap.asm")),
    assemble(join(sourceDirectory, "bdos", "bdos.asm")),
    assemble(join(sourceDirectory, "bios.asm")),
    readFile(resolve(cpmImagePath)),
  ]);
  const configuredScenario = process.env.TRIPTYCH_CPM_SCENARIO;
  const scenarioPaths = configuredScenario
    ? [resolve(configuredScenario)]
    : (await readdir(headlessScenarioDirectory))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name) => join(headlessScenarioDirectory, name));
  const scenarios = [];
  for (const scenarioPath of scenarioPaths) {
    const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
    const disk = Uint8Array.from(sourceDisk);
    disk.set(bios, BIOS_SYSTEM_OFFSET);
    if (scenario.systemBdos === "triptych") {
      disk.set(bdos, BDOS_SYSTEM_OFFSET);
    } else {
      assert.ok(
        scenario.systemBdos === undefined || scenario.systemBdos === "oracle",
        `${scenario.id} has an unsupported systemBdos`,
      );
    }
    const result = runCpmHeadlessScenario({
      scenario,
      initialDrive: padForBackingSectors(disk),
      createMachine(drive) {
        const machine = new TriptychCpu(bootRom);
        machine.install_drive(0, drive, true);
        return {
          enqueueInput(bytes) {
            machine.enqueue_serial_input(bytes);
          },
          runSlice() {
            machine.run_slice(50_000, 500_000);
          },
          serialOutput() {
            return machine.serial_output();
          },
          exportDrive() {
            return machine.export_drive(0);
          },
          close() {
            machine.free();
          },
        };
      },
    });
    scenarios.push({
      id: result.id,
      systemBdos: result.systemBdos,
      initialDriveSha256: result.initialDriveSha256,
      sessions: result.sessions,
    });
  }
  return { scenarios };
}

// Keep temporary-directory creation in the proof so an interrupted run never
// reuses state. CP/M media remains in WASM memory; no file is written there.
const temporary = await mkdtemp(join(tmpdir(), "triptych-wasm-proof-"));
try {
  const cpmHeadlessOnly = process.argv.slice(2).includes("--cpm-headless-only");
  const passed = [];
  if (!cpmHeadlessOnly) {
    const fixtureNames = (await readdir(fixtureDirectory))
      .filter((name) => name.endsWith(".json"))
      .sort();
    for (const name of fixtureNames) {
      const fixture = JSON.parse(
        await readFile(join(fixtureDirectory, name), "utf8"),
      );
      passed.push(runFixture(fixture));
    }
  }
  const cpm = await proveCpm();
  const report = {
    status: "passed",
    host: "triptych-host-wasm",
    ...(cpmHeadlessOnly ? {} : { fixtures: passed }),
    cpm,
  };
  console.log(JSON.stringify(report, undefined, 2));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
