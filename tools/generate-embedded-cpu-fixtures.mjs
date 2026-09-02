import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureDirectory = join(root, "test", "conformance", "fixtures");
const outputPath = join(
  root,
  "crates",
  "triptych-cpu-selftest",
  "src",
  "generated.rs",
);
const checkOnly = process.argv.includes("--check");

const cpuFields = new Map([
  ["a", "A"],
  ["a_prime", "APrime"],
  ["b", "B"],
  ["b_prime", "BPrime"],
  ["c", "C"],
  ["c_prime", "CPrime"],
  ["d", "D"],
  ["d_prime", "DPrime"],
  ["e", "E"],
  ["e_prime", "EPrime"],
  ["h", "H"],
  ["h_prime", "HPrime"],
  ["l", "L"],
  ["l_prime", "LPrime"],
  ["ix", "Ix"],
  ["iy", "Iy"],
  ["i", "I"],
  ["r", "R"],
  ["sp", "Sp"],
  ["pc", "Pc"],
  ["imode", "Imode"],
  ["iff1", "Iff1"],
  ["iff2", "Iff2"],
  ["halted", "Halted"],
  ["f.s", "FS"],
  ["f.z", "FZ"],
  ["f.y", "FY"],
  ["f.h", "FH"],
  ["f.x", "FX"],
  ["f.p", "FP"],
  ["f.n", "FN"],
  ["f.c", "FC"],
  ["f_prime.s", "FPrimeS"],
  ["f_prime.z", "FPrimeZ"],
  ["f_prime.y", "FPrimeY"],
  ["f_prime.h", "FPrimeH"],
  ["f_prime.x", "FPrimeX"],
  ["f_prime.p", "FPrimeP"],
  ["f_prime.n", "FPrimeN"],
  ["f_prime.c", "FPrimeC"],
]);

function fail(message) {
  throw new Error(message);
}

function bytes(values) {
  return `&[${values.join(", ")}]`;
}

function hexBytes(value) {
  if (!/^[0-9a-f]{64}$/.test(value)) fail(`invalid SHA-256: ${value}`);
  return `[${value
    .match(/../g)
    .map((byte) => `0x${byte}`)
    .join(", ")}]`;
}

function cpuField(name) {
  const variant = cpuFields.get(name);
  if (!variant) fail(`unsupported CPU field: ${name}`);
  return `CpuField::${variant}`;
}

function image(value, expectedSize, context) {
  if (value.size !== expectedSize) {
    fail(`${context}: expected ${expectedSize} bytes, got ${value.size}`);
  }
  for (const patch of value.patches) {
    if (
      !Number.isInteger(patch.address) ||
      patch.address < 0 ||
      patch.address + patch.bytes.length > value.size
    ) {
      fail(`${context}: patch is out of bounds`);
    }
  }
  return `ByteImage { size: ${value.size}, fill: ${value.fill}, patches: &[${value.patches
    .map(
      (patch) =>
        `BytePatch { address: ${patch.address}, bytes: ${bytes(patch.bytes)} }`,
    )
    .join(", ")}] }`;
}

function stopVariant(value) {
  const variants = {
    halt: "Stop::Halt",
    "step-limit": "Stop::StepLimit",
    "tstate-limit": "Stop::TStateLimit",
  };
  return variants[value] ?? fail(`unsupported stop reason: ${value}`);
}

function directionVariant(value) {
  return value === "read"
    ? "IoDirection::Read"
    : value === "write"
      ? "IoDirection::Write"
      : fail(`unsupported I/O direction: ${value}`);
}

function renderFixture(fixture, sourceHash) {
  if (fixture.format !== "triptych.cpu.conformance.fixture.v1") {
    fail(`${fixture.id}: unsupported fixture format`);
  }
  if (!/^[a-z0-9-]+$/.test(fixture.id))
    fail(`invalid fixture id: ${fixture.id}`);
  if (fixture.initial.drives.length > 1)
    fail(`${fixture.id}: more than one drive`);
  if (fixture.initial.serialInput.length > 1)
    fail(`${fixture.id}: serial input too large`);
  if (fixture.expected.result.serialOutput.length > 2) {
    fail(`${fixture.id}: serial output too large`);
  }
  if (fixture.expected.result.io.length > 272)
    fail(`${fixture.id}: I/O trace too large`);
  for (const interrupt of fixture.run.interrupts) {
    if (interrupt.kind !== "maskable" || interrupt.data !== 0xff) {
      fail(`${fixture.id}: unsupported interrupt`);
    }
  }

  const observedCpu = [...fixture.observe.cpu].sort();
  const expectedCpuNames = Object.keys(fixture.expected.result.cpu).sort();
  if (JSON.stringify(observedCpu) !== JSON.stringify(expectedCpuNames)) {
    fail(`${fixture.id}: observed and expected CPU fields differ`);
  }
  if (fixture.observe.ram.length !== fixture.expected.result.ram.length) {
    fail(`${fixture.id}: observed and expected RAM ranges differ`);
  }
  fixture.observe.ram.forEach((observed, index) => {
    const expected = fixture.expected.result.ram[index];
    if (
      !Number.isInteger(observed.address) ||
      !Number.isInteger(observed.length) ||
      observed.address < 0 ||
      observed.length < 0 ||
      observed.address + observed.length > 65_536
    ) {
      fail(`${fixture.id}: observed RAM range ${index} is out of bounds`);
    }
    if (
      expected.address !== observed.address ||
      expected.bytes.length !== observed.length
    ) {
      fail(`${fixture.id}: observed and expected RAM range ${index} differ`);
    }
  });

  const drive = fixture.initial.drives[0];
  const renderedDrive = drive
    ? `Some(${image(drive, 512, `${fixture.id} drive`)})`
    : "None";
  const initialCpu = Object.entries(fixture.initial.cpu).map(
    ([field, value]) =>
      `CpuPatch { field: ${cpuField(field)}, value: ${Number(value)} }`,
  );
  const expectedCpu = expectedCpuNames.map(
    (field) =>
      `CpuExpectation { field: ${cpuField(field)}, value: ${Number(
        fixture.expected.result.cpu[field],
      )} }`,
  );
  const ramObservations = fixture.observe.ram.map(
    (range) =>
      `RamRange { address: ${range.address}, length: ${range.length} }`,
  );
  const expectedRam = fixture.expected.result.ram.map(
    (range) =>
      `RamExpectation { address: ${range.address}, bytes: ${bytes(range.bytes)} }`,
  );
  const expectedIo = fixture.expected.result.io.map(
    (operation) =>
      `IoOperation { direction: ${directionVariant(operation.direction)}, port: ${operation.port}, value: ${operation.value} }`,
  );

  return `    Fixture {
        id: ${JSON.stringify(fixture.id)},
        source_sha256: ${hexBytes(sourceHash)},
        boot_rom: ${image(fixture.initial.bootRom, 256, `${fixture.id} boot ROM`)},
        ram: ${image(fixture.initial.ram, 65_536, `${fixture.id} RAM`)},
        drive: ${renderedDrive},
        serial_input: ${bytes(fixture.initial.serialInput)},
        initial_cpu: &[${initialCpu.join(", ")}],
        max_steps: ${fixture.run.maxSteps},
        max_tstates: ${fixture.run.maxTStates},
        interrupts_after_step: ${bytes(
          fixture.run.interrupts.map((interrupt) => interrupt.afterStep),
        )},
        observe_cpu: &[${observedCpu.map(cpuField).join(", ")}],
        observe_ram: &[${ramObservations.join(", ")}],
        expected: ExpectedResult {
            stop: ${stopVariant(fixture.expected.result.stop)},
            steps: ${fixture.expected.result.steps},
            tstates: ${fixture.expected.result.tStates},
            cpu: &[${expectedCpu.join(", ")}],
            boot_rom_enabled: ${fixture.expected.result.bootRomEnabled},
            ram_sha256: ${hexBytes(fixture.expected.result.ramSha256)},
            ram: &[${expectedRam.join(", ")}],
            drive_sha256: &[${fixture.expected.result.driveSha256
              .map(hexBytes)
              .join(", ")}],
            serial_output: ${bytes(fixture.expected.result.serialOutput)},
            io: &[${expectedIo.join(", ")}],
            digest: ${hexBytes(fixture.expected.digest)},
        },
    }`;
}

const names = (await readdir(fixtureDirectory))
  .filter((name) => name.endsWith(".json"))
  .sort();
const rendered = [];
for (const name of names) {
  const source = await readFile(join(fixtureDirectory, name));
  const fixture = JSON.parse(source.toString("utf8"));
  rendered.push(
    renderFixture(fixture, createHash("sha256").update(source).digest("hex")),
  );
}

const unformattedOutput = `// Generated by tools/generate-embedded-cpu-fixtures.mjs.
// Source: ${relative(root, fixtureDirectory)}/*.json
// Do not edit by hand.

use super::{
    ByteImage, BytePatch, CpuExpectation, CpuField, CpuPatch, ExpectedResult, Fixture,
    RamExpectation, RamRange, Stop,
};
use triptych_cpu_core::{IoDirection, IoOperation};

pub(crate) static FIXTURES: &[Fixture] = &[
${rendered.join(",\n")},
];
`;
const formatted = spawnSync(
  "rustfmt",
  ["--emit", "stdout", "--edition", "2021"],
  {
    encoding: "utf8",
    input: unformattedOutput,
  },
);
if (formatted.error) throw formatted.error;
if (formatted.status !== 0) {
  fail(`rustfmt failed:\n${formatted.stderr}`);
}
const output = formatted.stdout;

if (checkOnly) {
  const existing = await readFile(outputPath, "utf8").catch(() => "");
  if (existing !== output) {
    console.error(
      `${relative(root, outputPath)} is stale; run npm run generate:cpu-fixtures`,
    );
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output);
  console.log(
    `generated ${relative(root, outputPath)} (${names.length} fixtures)`,
  );
}
