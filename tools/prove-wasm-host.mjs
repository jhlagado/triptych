import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { compile, defaultFormatWriters } from "@jhlagado/azm/compile";
import { retargetCpm22Atom } from "./lib/cpm22-atom-target.mjs";
import { installCpm22File, readCpm22File } from "./lib/cpm22-disk.mjs";
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
const headlessScenarioDirectories = [
  join(repositoryRoot, "test", "bdos", "scenarios"),
  join(repositoryRoot, "test", "ccp", "scenarios"),
];
const require = createRequire(import.meta.url);
const { TriptychCpu } = require(
  join(repositoryRoot, "dist", "wasm", "triptych_host_wasm.js"),
);

const FIXTURE_FORMAT = "triptych.cpu.conformance.fixture.v1";
const RESULT_FORMAT = "triptych.cpu.conformance.result.v1";
const BACKING_SECTOR_BYTES = 512;
const CCP_SYSTEM_OFFSET = 0x0000;
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
    machine.set_io_trace_enabled(true);
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

function repositoryPath(path) {
  assert.equal(typeof path, "string", "initial file path must be text");
  const absolute = resolve(repositoryRoot, path);
  const local = relative(repositoryRoot, absolute);
  assert.ok(
    local !== "" &&
      local !== ".." &&
      !local.startsWith(`..${sep}`) &&
      !isAbsolute(local),
    `initial file path escapes the repository: ${path}`,
  );
  return absolute;
}

function cpmText(bytes, path) {
  const text = Buffer.from(bytes).toString("utf8");
  assert.equal(
    Buffer.from(text, "utf8").compare(Buffer.from(bytes)),
    0,
    `${path} is not valid UTF-8`,
  );
  assert.ok(
    [...text].every((character) => character.codePointAt(0) <= 0x7f),
    `${path} contains non-ASCII text`,
  );
  return Uint8Array.from(
    Buffer.from(text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "ascii"),
  );
}

async function proveCpm() {
  const cpmImagePath = resolve(
    process.env.TRIPTYCH_CPM22_IMAGE ??
      join(repositoryRoot, "third_party", "cpm22", "cpm22.img"),
  );
  const [bootRom, ccp, bdos, bios, sourceDisk] = await Promise.all([
    assemble(join(sourceDirectory, "bootstrap.asm")),
    assemble(join(sourceDirectory, "ccp", "ccp.asm")),
    assemble(join(sourceDirectory, "bdos", "bdos.asm")),
    assemble(join(sourceDirectory, "bios.asm")),
    readFile(resolve(cpmImagePath)),
  ]);
  const configuredScenario = process.env.TRIPTYCH_CPM_SCENARIO;
  const scenarioPaths = configuredScenario
    ? [resolve(configuredScenario)]
    : (
        await Promise.all(
          headlessScenarioDirectories.map(async (directory) =>
            (await readdir(directory))
              .filter((name) => name.endsWith(".json"))
              .map((name) => join(directory, name)),
          ),
        )
      )
        .flat()
        .sort();
  const scenarios = [];
  for (const scenarioPath of scenarioPaths) {
    const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
    let disk = Uint8Array.from(sourceDisk);
    disk.set(bios, BIOS_SYSTEM_OFFSET);
    if (scenario.systemCcp === "triptych") {
      disk.set(ccp, CCP_SYSTEM_OFFSET);
    } else {
      assert.ok(
        scenario.systemCcp === undefined || scenario.systemCcp === "oracle",
        `${scenario.id} has an unsupported systemCcp`,
      );
    }
    if (scenario.systemBdos === "triptych") {
      disk.set(bdos, BDOS_SYSTEM_OFFSET);
    } else {
      assert.ok(
        scenario.systemBdos === undefined || scenario.systemBdos === "oracle",
        `${scenario.id} has an unsupported systemBdos`,
      );
    }
    for (const initialFile of scenario.initialFiles ?? []) {
      const sourcePath = repositoryPath(initialFile.path);
      const source = await readFile(sourcePath);
      assert.equal(
        initialFile.encoding,
        "cpm-text",
        `${scenario.id} initial file encoding`,
      );
      disk = installCpm22File(disk, {
        name: initialFile.name,
        bytes: cpmText(source, initialFile.path),
      });
    }
    const initialPrograms = [];
    for (const program of scenario.initialPrograms ?? []) {
      assert.equal(
        program.kind,
        "assemble-atom",
        `${scenario.id} initial program kind`,
      );
      const sourcePath = repositoryPath(program.path);
      const binary = await assemble(sourcePath);
      const digest = sha256(binary);
      assert.equal(
        binary.length,
        program.bytes,
        `${scenario.id} ${program.name} bytes`,
      );
      assert.equal(
        digest,
        program.sha256,
        `${scenario.id} ${program.name} SHA-256`,
      );
      disk = installCpm22File(disk, {
        name: program.name,
        bytes: binary,
      });
      initialPrograms.push({
        name: program.name,
        bytes: binary.length,
        sha256: digest,
      });
    }
    const initialTools = [];
    for (const tool of scenario.initialTools ?? []) {
      assert.equal(
        tool.kind,
        "retarget-cpm22-atom",
        `${scenario.id} initial tool kind`,
      );
      const derived = retargetCpm22Atom(readCpm22File(disk, tool.source), {
        start: tool.targetStart,
        capacity: tool.targetCapacity,
      });
      const digest = sha256(derived);
      assert.equal(digest, tool.sha256, `${scenario.id} ${tool.name} SHA-256`);
      disk = installCpm22File(disk, {
        name: tool.name,
        bytes: derived,
      });
      initialTools.push({
        name: tool.name,
        bytes: derived.length,
        sha256: digest,
      });
    }
    const result = runCpmHeadlessScenario({
      scenario,
      initialDrive: padForBackingSectors(disk),
      maximumSlices: scenario.maximumSlices ?? 400,
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
    const finalFiles = [];
    for (const expected of scenario.expectedFinalFiles ?? []) {
      const file = readCpm22File(result.finalDrive, expected.name);
      assert.equal(
        file.length,
        expected.bytes,
        `${scenario.id} ${expected.name} bytes`,
      );
      const digest = sha256(file);
      assert.equal(
        digest,
        expected.sha256,
        `${scenario.id} ${expected.name} SHA-256`,
      );
      finalFiles.push({
        name: expected.name,
        bytes: file.length,
        sha256: digest,
      });
    }
    scenarios.push({
      id: result.id,
      systemCcp: result.systemCcp,
      systemBdos: result.systemBdos,
      initialDriveSha256: result.initialDriveSha256,
      ...(initialPrograms.length === 0 ? {} : { initialPrograms }),
      ...(initialTools.length === 0 ? {} : { initialTools }),
      sessions: result.sessions,
      ...(finalFiles.length === 0 ? {} : { finalFiles }),
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
