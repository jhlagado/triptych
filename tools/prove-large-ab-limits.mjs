import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";
import { buildLargeAbSystem } from "./lib/large-ab-system.mjs";

// Supplemental capacity/lifetime proof. It consumes retained releases and
// existing hosts; it never rebuilds hosts, edits tool source or changes pins.
const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu, CpmDisk } = require("../dist/wasm/triptych_host_wasm.js");
const suiteName = process.argv
  .find((arg) => arg.startsWith("--suite="))
  ?.slice(8);
const suiteModules = {
  "atom-symbols": "./lib/large-ab-atom-arenas.mjs",
  "atom-parts": "./lib/large-ab-atom-arenas.mjs",
  "atom-chain": "./lib/large-ab-atom-arenas.mjs",
  edit: "./lib/large-ab-edit-arenas.mjs",
  nucleus: "./lib/large-ab-nucleus-arenas.mjs",
};
assert(
  suiteName === undefined || Object.hasOwn(suiteModules, suiteName),
  "unknown capacity suite",
);
// A suite supplies only fixtures and assertions. The same instruction observer,
// resident guards and native whole-image replay qualify every tool's lifetime.
const suite = suiteName
  ? (await import(suiteModules[suiteName])).createSuite(suiteName)
  : undefined;
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const distribution = await buildCpmDistribution(root, {
  allowDirty: process.argv.includes("--allow-dirty"),
});
const system = await buildLargeAbSystem(root, distribution);
const evidence = await mkdtemp(join(tmpdir(), "triptych-ab-limits-"));
console.log(`Evidence: ${evidence}`);
const withDisk = (bytes, action) => {
  const disk = new CpmDisk(bytes);
  try {
    return action(disk);
  } finally {
    disk.free();
  }
};
const base = withDisk(distribution.disk, (disk) =>
  Buffer.from(disk.migrate_to_eight_mib(system.bytes)),
);
const paddedSource = (prefix, comment, length) =>
  Buffer.from(
    prefix + comment + " ".repeat(length - prefix.length - comment.length),
    "ascii",
  );
const nuc = "sub main() fails\n    writeOutputByte('K') else fail\nend\n";
let fixtures = new Map([
  ["AMAX.ASM", Buffer.from("ORG $0100\nRET\nDS 18303,0\n")],
  ["AOVER.ASM", Buffer.from("ORG $0100\nRET\nDS 18304,0\n")],
  ["ASRC.ASM", paddedSource("ORG $0100\nRET\n", ";", 65535)],
  ["ASRCOV.ASM", paddedSource("ORG $0100\nRET\n", ";", 65536)],
  ["NSRC.NU", paddedSource(nuc, "//", 65535)],
  ["NSRCOV.NU", paddedSource(nuc, "//", 65536)],
  ["FAIL.NU", Buffer.from("sub main() fails\n    fail 7\nend\n")],
  [
    "TRAP.NU",
    Buffer.from(
      "var data as u8[1] = [65]\nsub main() fails\n    var i as u16 = 1\n    writeOutputByte(data[i]) else fail\nend\n",
    ),
  ],
  ["EMAX.TXT", Buffer.alloc(47104, 65)],
  ["EOVER.TXT", Buffer.alloc(47105, 66)],
  ["END.TXT", Buffer.from("AB-LIMITS-END")],
]);
const prompt = "\r\nB>";
const cmd = (id, text, tool, required, check) => ({
  id,
  input: text + "\r",
  tool,
  required,
  check,
  suffix: prompt,
});
let atomOutput, smallAtomOutput, nucOutput;
let steps = [
  { id: "boot", input: "", suffix: "\r\nA>" },
  cmd("select-b", "B:"),
  cmd(
    "atom-output-limit",
    "ATOM AMAX.ASM KEEP.COM",
    "ATOM.COM",
    "KEEP.COM written",
    (disk) => {
      atomOutput = Buffer.from(disk.read_file("KEEP.COM"));
      assert.equal(atomOutput.length, 18304);
      assert.equal(atomOutput[0], 0xc9);
      assert(atomOutput.subarray(1).every((x) => x === 0));
    },
  ),
  cmd(
    "atom-output-over",
    "ATOM AOVER.ASM KEEP.COM",
    "ATOM.COM",
    "Atom error 02 00 000E",
    (disk) =>
      assert.deepEqual(Buffer.from(disk.read_file("KEEP.COM")), atomOutput),
  ),
  cmd("atom-limit-output-return", "KEEP", "KEEP.COM"),
  cmd(
    "atom-source-limit",
    "ATOM ASRC.ASM SMALL.COM",
    "ATOM.COM",
    "SMALL.COM written",
    (disk) => {
      smallAtomOutput = Buffer.from(disk.read_file("SMALL.COM"));
      assert.equal(smallAtomOutput[0], 0xc9);
    },
  ),
  cmd(
    "atom-source-over",
    "ATOM ASRCOV.ASM SMALL.COM",
    "ATOM.COM",
    "ASRCOV.ASM read failed",
    (disk) =>
      assert.deepEqual(
        Buffer.from(disk.read_file("SMALL.COM")),
        smallAtomOutput,
      ),
  ),
  cmd(
    "nuc-source-limit",
    "NUC NSRC.NU NKEEP.COM",
    "NUC.COM",
    undefined,
    (disk) => {
      nucOutput = Buffer.from(disk.read_file("NKEEP.COM"));
      assert(nucOutput.length > 2048);
    },
  ),
  cmd(
    "nuc-source-over",
    "NUC NSRCOV.NU NKEEP.COM",
    "NUC.COM",
    "Nucleus host error 04",
    (disk) =>
      assert.deepEqual(Buffer.from(disk.read_file("NKEEP.COM")), nucOutput),
  ),
  cmd("nuc-preserved-output-return", "NKEEP", "NKEEP.COM", "\r\nK\r\n"),
  cmd("compile-failure-program", "NUC FAIL.NU", "NUC.COM"),
  cmd(
    "generated-unhandled-failure",
    "FAIL",
    "FAIL.COM",
    "Unhandled Nucleus failure",
  ),
  cmd("compile-trap-program", "NUC TRAP.NU", "NUC.COM"),
  cmd("generated-bounds-trap", "TRAP", "TRAP.COM", "Nucleus trap"),
  {
    ...cmd(
      "editor-text-limit",
      "EDIT EMAX.TXT",
      "EDIT.COM",
      "EDIT EMAX    .TXT",
    ),
    suffix: "\x1b[1;1H",
    open: true,
    checkMemory: (machine) =>
      assert.deepEqual(
        Buffer.from(machine.read_ram(0x2000, 47104)),
        fixtures.get("EMAX.TXT"),
      ),
  },
  {
    id: "editor-full-insert",
    input: "Z",
    suffix: "\x1b[1;1H",
    required: "Full",
    open: true,
    checkMemory: (machine) =>
      assert.deepEqual(
        Buffer.from(machine.read_ram(0x2000, 47104)),
        fixtures.get("EMAX.TXT"),
      ),
  },
  {
    id: "editor-limit-return",
    input: "\x11",
    suffix: prompt,
    check: (disk) =>
      assert.deepEqual(
        Buffer.from(disk.read_file("EMAX.TXT")),
        fixtures.get("EMAX.TXT"),
      ),
  },
  cmd(
    "editor-text-over",
    "EDIT EOVER.TXT",
    "EDIT.COM",
    "EDIT error 04",
    (disk) => {
      const bytes = Buffer.from(disk.read_file("EOVER.TXT"));
      assert.deepEqual(bytes.subarray(0, 47105), fixtures.get("EOVER.TXT"));
      assert(bytes.subarray(47105).every((x) => x === 26));
    },
  ),
  cmd("following-command", "TYPE END.TXT", undefined, "AB-LIMITS-END"),
];
if (suite) {
  fixtures = suite.fixtures;
  steps = suite.steps;
}
const b = withDisk(base, (disk) => {
  for (const [name, bytes] of fixtures) disk.add_import(name, bytes);
  return Buffer.from(disk.export_candidate());
});
const inputs = [base, b];
const fixtureRecords = withDisk(
  b,
  (disk) =>
    new Map(
      disk
        .file_names()
        .map((name) => [name, Buffer.from(disk.read_file(name))]),
    ),
);
for (const name of suite?.mutableFiles ?? []) {
  assert(fixtures.has(name), "only suite-owned fixtures may be mutable");
  assert(
    steps.every((step) => typeof step.check === "function"),
    "mutable fixtures require per-checkpoint assertions",
  );
}
const floors = { "ATOM.COM": 0xd800, "NUC.COM": 0xd500, "EDIT.COM": 0xd800 };
const cpu = new TriptychCpu(system.bootstrap);
inputs.forEach((bytes, drive) => cpu.install_drive(drive, bytes, true));
const guardAddresses = [0xfdff, 0xffff];
const reports = [],
  lifetimes = [],
  retained = new Map();
let transcript = Buffer.alloc(0),
  active,
  pending,
  reload = true,
  installedGuards = false;
let minBdosSp = system.resident.bdosStackTop;
async function retain(bytes) {
  const sha = hash(bytes);
  if (!retained.has(sha)) {
    const path = join(evidence, sha + ".img");
    await writeFile(path, bytes);
    retained.set(sha, path);
  }
  return { sha256: sha, path: retained.get(sha) };
}
function immutable() {
  assert.deepEqual(
    Buffer.from(
      cpu.read_ram(0xeb00, system.resident.bdosWritableStart - 0xeb00),
    ),
    Buffer.from(system.resident.bdosBytes).subarray(
      0,
      system.resident.bdosWritableStart - 0xeb00,
    ),
  );
  for (const r of system.resident.biosImmutableRanges)
    assert.deepEqual(
      Buffer.from(cpu.read_ram(r.start, r.end - r.start)),
      Buffer.from(r.bytes),
    );
  if (installedGuards)
    for (const address of guardAddresses)
      assert.equal(cpu.read_ram(address, 1)[0], 0x59);
}
function observe() {
  const state = cpu.cpu_state();
  let pc, sp;
  try {
    pc = state.pc();
    sp = state.sp();
  } finally {
    state.free();
  }
  if (pc >= 0xeb00 && sp >= 0xeb00 && sp < 0xf900) {
    minBdosSp = Math.min(minBdosSp, sp);
    assert(
      sp >= system.resident.bdosStackBase && sp <= system.resident.bdosStackTop,
    );
  }
  if (reload && pc === 0xe300) {
    assert.deepEqual(
      Buffer.from(cpu.read_ram(0xe300, 2048)),
      Buffer.from(system.resident.ccpBytes),
    );
    assert.deepEqual(
      Buffer.from(cpu.read_ram(0xeb00, 3584)),
      Buffer.from(system.resident.bdosBytes),
    );
    reload = false;
    if (lifetimes.length) lifetimes.at(-1).reloaded = true;
  }
  if (pending && pc === 0x100) {
    assert(sp >= 0xe400 && sp + 2 <= 0xeb00);
    assert.equal(Buffer.from(cpu.read_ram(sp, 2)).readUInt16LE(), 0);
    assert.deepEqual(
      Buffer.from(cpu.read_ram(0x100, pending.bytes.length)),
      pending.bytes,
    );
    active = { id: pending.id, tool: pending.tool, entrySp: sp, minimumSp: sp };
    pending = undefined;
  }
  if (active) {
    assert(pc < 0xe300 || pc >= 0xeb00, "must not execute dead CCP");
    if (pc >= 0x100 && pc < 0xe300) {
      active.minimumSp = Math.min(active.minimumSp, sp);
      if (floors[active.tool] && sp < 0xe400)
        assert(
          sp >= floors[active.tool],
          `${active.tool} stack crossed output/text boundary`,
        );
      if (!floors[active.tool])
        assert(
          sp >= 0xe400,
          `${active.tool}: generated stack entered tool workspace`,
        );
    }
    suite?.observe?.(cpu, { pc, sp }, active);
    if (pc === 0 && !cpu.boot_rom_enabled()) {
      assert.equal(sp, active.entrySp + 2, `${active.id}: exact RET stack`);
      assert.equal(
        Buffer.from(cpu.read_ram(active.entrySp, 2)).readUInt16LE(),
        0,
      );
      assert.equal(cpu.read_ram(4, 1)[0], 1);
      immutable();
      lifetimes.push({ ...active, returnSp: sp, returnPc: pc });
      active = undefined;
      reload = true;
    }
  }
}
try {
  for (const step of steps) {
    const begin = transcript.length,
      started = Date.now(),
      beforeLifetimes = lifetimes.length;
    if (step.tool) {
      assert(!active);
      pending = {
        id: step.id,
        tool: step.tool,
        bytes: withDisk(cpu.export_drive_checkpoint(1), (d) =>
          Buffer.from(d.read_file(step.tool)),
        ),
      };
    }
    assert(cpu.enqueue_serial_input(Buffer.from(step.input, "latin1")));
    const maxInstructions = step.maxInstructions ?? 150_000_000;
    const maxMs = step.maxMs ?? 180_000;
    let count = 0,
      reached = false;
    while (count < maxInstructions && Date.now() - started < maxMs) {
      if (active || pending || reload) {
        for (let i = 0; i < 512; i++) {
          observe();
          cpu.step(false);
        }
        count += 512;
      } else {
        cpu.run_slice(10000, 100000);
        count += Number(cpu.last_steps());
      }
      assert(!cpu.last_halted(), `${step.id}: unexpected HALT`);
      transcript = Buffer.concat([
        transcript,
        Buffer.from(cpu.take_serial_output()),
      ]);
      const fresh = transcript.subarray(begin).toString("latin1");
      const required =
        step.required === undefined ||
        (step.required instanceof RegExp
          ? step.required.test(fresh)
          : fresh.includes(step.required));
      if (
        fresh.length &&
        transcript
          .subarray(-step.suffix.length)
          .equals(Buffer.from(step.suffix, "latin1")) &&
        required
      ) {
        reached = true;
        break;
      }
      if (count % 65536 === 0) await new Promise((done) => setTimeout(done, 0));
    }
    assert(
      reached,
      `${step.id}: no complete output boundary after ${count} instructions: ${transcript.subarray(begin).toString("latin1")}`,
    );
    if (!step.open) {
      assert(
        !active && !pending && !reload,
        `${step.id}: real return/reload required`,
      );
      if (step.tool) assert.equal(lifetimes.length, beforeLifetimes + 1);
    }
    if (!installedGuards) {
      for (const address of guardAddresses)
        cpu.write_ram(address, Uint8Array.of(0x59));
      installedGuards = true;
    }
    immutable();
    step.checkOutput?.(transcript.subarray(begin));
    step.checkMemory?.(cpu);
    assert(
      cpu.disk_management_ready(),
      `${step.id}: coherent all-drive checkpoint`,
    );
    const snapshots = [];
    for (let drive = 0; drive < 2; drive++) {
      const bytes = Buffer.from(cpu.export_drive_checkpoint(drive));
      assert.deepEqual(bytes, Buffer.from(cpu.export_drive(drive)));
      assert.deepEqual(
        bytes.subarray(0, 16384),
        inputs[drive].subarray(0, 16384),
      );
      if (!drive) assert.deepEqual(bytes, inputs[0]);
      snapshots.push(await retain(bytes));
    }
    withDisk(cpu.export_drive_checkpoint(1), (disk) => {
      for (const [name, bytes] of fixtureRecords)
        if (!suite?.mutableFiles?.has(name))
          assert.deepEqual(Buffer.from(disk.read_file(name)), bytes);
      for (const stem of suite?.outputStems ?? ["KEEP", "SMALL", "NKEEP"])
        for (const extension of ["$$$", "BAK"])
          assert(
            !disk.file_names().includes(`${stem}.${extension}`),
            "no stranded compiler publication files",
          );
      step.check?.(disk);
    });
    const path = join(evidence, step.id + ".console");
    await writeFile(path, transcript);
    reports.push({
      id: step.id,
      input: step.input,
      transcript: Buffer.from(transcript),
      path,
      snapshots,
      instructions: count,
      elapsedMs: Date.now() - started,
    });
    console.log(`${step.id}: WASM passed (${count} instructions)`);
  }
} finally {
  cpu.free();
}
assert(lifetimes.every((item) => item.reloaded));
const bootPath = join(evidence, "bootstrap.bin");
await writeFile(bootPath, system.bootstrap);
const nativePaths = inputs.map((_, drive) =>
  join(evidence, `native-${drive}.img`),
);
await Promise.all(
  nativePaths.map((path, drive) => writeFile(path, inputs[drive])),
);
const child = spawn(
  join(root, "target/debug/triptych-host-native"),
  [
    "--stop-after",
    `AB-LIMITS-END${prompt}`,
    "--max-steps",
    "2000000000",
    bootPath,
    ...nativePaths,
  ],
  { stdio: ["pipe", "pipe", "pipe"] },
);
let output = Buffer.alloc(0),
  stderr = "",
  closed = false,
  error;
child.stdout.on("data", (bytes) => (output = Buffer.concat([output, bytes])));
child.stderr.on("data", (bytes) => (stderr += bytes.toString()));
child.on("error", (cause) => (error = cause));
child.stdin.on("error", (cause) => (error = cause));
const completion = new Promise((done) =>
  child.on("close", (code, signal) => {
    closed = true;
    done({ code, signal });
  }),
);
async function wait(length) {
  const deadline = Date.now() + 180000;
  while (output.length < length) {
    assert(
      !error && !closed && Date.now() < deadline,
      `native did not reach checkpoint: ${error ?? stderr}`,
    );
    await new Promise((done) => setTimeout(done, 10));
  }
}
try {
  for (const checkpoint of reports) {
    if (checkpoint.input)
      child.stdin.write(Buffer.from(checkpoint.input, "latin1"));
    await wait(checkpoint.transcript.length);
    assert.deepEqual(output, checkpoint.transcript, checkpoint.id);
    for (let d = 0; d < 2; d++)
      assert.deepEqual(
        await readFile(nativePaths[d]),
        await readFile(checkpoint.snapshots[d].path),
        `${checkpoint.id}: complete drive${d} parity`,
      );
  }
  const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
  try {
    assert.deepEqual(await completion, { code: 0, signal: null }, stderr);
  } finally {
    clearTimeout(timer);
  }
} finally {
  if (!closed) {
    child.kill("SIGKILL");
    await completion;
  }
}
const result = {
  status: "passed",
  suite: suiteName ?? "source-output-text",
  evidence,
  profile: system.profile,
  components: system.components,
  checkpoints: reports.map(({ transcript, ...r }) => ({
    ...r,
    transcriptSha256: hash(transcript),
  })),
  lifetimes,
  maximumBdosStackBytes: system.resident.bdosStackTop - minBdosSp,
  limits: [
    ...(suite?.limits ?? [
      "ATOM source/output, NUC source and Edit text capacities plus generated unhandled failure/bounds trap only; symbol/pending/dependency tables, NUC generated-image/writable arenas and recursive activation capacities not proved",
    ]),
    "PC/SP observations are WASM measurements; native evidence is exact console and complete two-drive images",
    "not browser or ESP32 qualification",
  ],
};
await writeFile(
  join(evidence, "result.json"),
  JSON.stringify(result, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    {
      status: result.status,
      evidence,
      checkpoints: reports.length,
      lifetimes: lifetimes.length,
      limits: result.limits,
    },
    null,
    2,
  ),
);
