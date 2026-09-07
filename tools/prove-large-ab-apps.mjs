import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TerminalBuffer } from "../crates/triptych-host-wasm/web/terminal.js";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const IMAGE_BYTES = 8_388_608;
const CCP = 0xe300;
const BDOS = 0xeb00;
const BIOS = 0xf900;
const LOAD_BYTES = CCP - 0x100;
const GUARDS = [0xfdff, 0xffff];
const TOOL_FLOORS = {
  "ATOM.COM": 0xd800,
  "NUC.COM": 0xd500,
  "EDIT.COM": 0xd800,
};
const PRIVATE_STACK_GAMES = new Set(["CAVERNS.COM", "HYPERDRV.COM"]);
const prompt = (drive) => `\r\n${drive ? "B" : "A"}>`;
const endSuffix = `AB-PROOF-END${prompt(1)}`;
const editorCursor = "\x1b[2;21H";

function screen(bytes) {
  const terminal = new TerminalBuffer();
  terminal.write(bytes);
  return terminal.snapshot();
}

function scenarios() {
  const command = (id, input, required, options = {}) => ({
    id,
    input: `${input}\r`,
    suffix: prompt(1),
    required,
    ...options,
  });
  return [
    {
      id: "tools-on-b",
      steps: [
        { id: "boot", input: "", suffix: prompt(0) },
        command("a-identity", "TYPE SIDE.TXT", "DRIVE-A-ORIGINAL", {
          suffix: prompt(0),
        }),
        command("explicit-b-from-a", "TYPE B:SIDE.TXT", "DRIVE-B-ORIGINAL", {
          suffix: prompt(0),
        }),
        command("select-b", "B:"),
        command("b-identity", "TYPE SIDE.TXT", "DRIVE-B-ORIGINAL"),
        command("explicit-a-from-b", "TYPE A:SIDE.TXT", "DRIVE-A-ORIGINAL"),
        command("caverns-start", "CAVERNS", "C A V E R N S", {
          launch: "CAVERNS.COM",
          suffix: "[Space/Enter: more, Q: skip] ",
          staysOpen: true,
        }),
        { id: "caverns-skip", input: "q", suffix: "? ", staysOpen: true },
        {
          id: "caverns-inventory",
          input: "inventory\r",
          suffix: "? ",
          required: "You are carrying",
          staysOpen: true,
        },
        {
          id: "caverns-quit",
          input: "quit\r",
          suffix: "Another adventure? ",
          staysOpen: true,
        },
        { id: "caverns-return", input: "n\r", suffix: prompt(1) },
        command("hyperdrive-start", "HYPERDRV", "Hyperdrive", {
          launch: "HYPERDRV.COM",
          suffix: "? ",
          staysOpen: true,
        }),
        {
          id: "hyperdrive-inventory",
          input: "inventory\r",
          suffix: "? ",
          required: "You are carrying:",
          staysOpen: true,
        },
        {
          id: "hyperdrive-quit",
          input: "quit\r",
          suffix: "Return to CP/M? (Y/N) ",
          staysOpen: true,
        },
        { id: "hyperdrive-return", input: "y\r", suffix: prompt(1) },
        command("exact-load-limit", "FIT", undefined, { launch: "FIT.COM" }),
        command("reject-over-limit", "OVER", "OVER?", { rejectLaunch: true }),
        command("atom-success", "ATOM HELLO.ASM", "HELLO.COM written", {
          launch: "ATOM.COM",
        }),
        command("generated-atom-return", "HELLO", "Hello from ATOM", {
          launch: "HELLO.COM",
        }),
        command("atom-error", "ATOM BAD.ASM", /error/i, { launch: "ATOM.COM" }),
        command("nucleus-error", "NUC BAD.NU", /error|fail/i, {
          launch: "NUC.COM",
        }),
        command("edit-error", "EDIT FOO.BAK", "EDIT error 01", {
          launch: "EDIT.COM",
        }),
        command(
          "edit-open",
          "EDIT INPUT.NU",
          "EDIT INPUT   .NU       ^S Save  ^Q Quit",
          { launch: "EDIT.COM", suffix: "\x1b[1;1H", staysOpen: true },
        ),
        {
          id: "edit-find",
          input: "\x06'O'\r",
          suffix: editorCursor,
          staysOpen: true,
        },
        {
          id: "edit-replace",
          input: "\x12'Y'\r",
          suffix: editorCursor,
          required: "'Y'",
          staysOpen: true,
        },
        {
          id: "edit-save",
          input: "\x13",
          suffix: editorCursor,
          staysOpen: true,
        },
        { id: "edit-quit-warm-b", input: "\x11", suffix: prompt(1) },
        command("nucleus-success", "NUC INPUT.NU", undefined, {
          launch: "NUC.COM",
        }),
        command("generated-nucleus-return", "INPUT", "YK", {
          launch: "INPUT.COM",
        }),
        command("finish", "TYPE END.TXT", "AB-PROOF-END"),
      ],
    },
    {
      id: "fresh-reopen",
      readOnly: true,
      steps: [
        { id: "boot", input: "", suffix: prompt(0) },
        command("a-preserved", "TYPE INPUT.NU", "writeOutputByte('O')", {
          suffix: prompt(0),
        }),
        command(
          "explicit-persisted-b",
          "TYPE B:INPUT.NU",
          "writeOutputByte('Y')",
          { suffix: prompt(0) },
        ),
        command("select-b", "B:"),
        command("edit-reopen", "EDIT INPUT.NU", "'Y'", {
          launch: "EDIT.COM",
          suffix: "\x1b[1;1H",
          staysOpen: true,
        }),
        { id: "edit-quit-warm-b", input: "\x11", suffix: prompt(1) },
        command("rerun-atom-output", "HELLO", "Hello from ATOM", {
          launch: "HELLO.COM",
        }),
        command("rerun-nucleus-output", "INPUT", "YK", { launch: "INPUT.COM" }),
        command("finish", "TYPE END.TXT", "AB-PROOF-END"),
      ],
    },
  ];
}

/** Qualify caller-supplied, provenance-checked E300/EB00/F900 artifacts.
 * This function never locates source checkouts, selects releases, rebuilds hosts,
 * or installs component pins. The caller owns those boundaries.
 * components: [{name: "ATOM.COM" | "NUC.COM" | "EDIT.COM" | "CAVERNS.COM" | "HYPERDRV.COM", bytes, sha256}].
 * resident: {ccpBytes, ccpWritableStart, ccpStackGuardStart, ccpStackGuardEnd,
 * bdosBytes, bdosWritableStart, bdosStackBase, bdosStackTop,
 * biosImmutableRanges: [{start, end, bytes}]} (addresses are absolute).
 */
export async function proveLargeAbApps({
  bootstrap,
  drives,
  components,
  resident,
  evidenceDirectory,
}) {
  const {
    TriptychCpu,
    CpmDisk,
  } = require("../dist/wasm/triptych_host_wasm.js");
  assert.equal(bootstrap.length, 256);
  assert.equal(drives.length, 2);
  for (const bytes of drives) assert.equal(bytes.length, IMAGE_BYTES);
  assert.equal(resident.ccpBytes.length, 2048);
  assert.equal(resident.bdosBytes.length, 3584);
  assert.deepEqual(
    Buffer.from(drives[0]).subarray(0, 2048),
    Buffer.from(resident.ccpBytes),
    "A system records contain the supplied CCP",
  );
  assert.deepEqual(
    Buffer.from(drives[0]).subarray(2048, 5632),
    Buffer.from(resident.bdosBytes),
    "A system records contain the supplied BDOS",
  );
  assert.ok(
    resident.ccpWritableStart > CCP && resident.ccpWritableStart < BDOS,
  );
  assert.ok(
    resident.bdosWritableStart > BDOS &&
      resident.bdosWritableStart <= resident.bdosStackBase,
  );
  assert.equal(resident.bdosStackTop - resident.bdosStackBase, 64);
  assert.ok(resident.bdosStackTop <= BIOS);
  assert.ok(resident.ccpStackGuardStart >= resident.ccpWritableStart);
  assert.ok(
    resident.ccpStackGuardEnd <= BDOS &&
      resident.ccpStackGuardEnd > resident.ccpStackGuardStart,
  );
  assert.ok(resident.biosImmutableRanges.length > 0);
  for (const range of resident.biosImmutableRanges) {
    assert.ok(
      range.start >= BIOS && range.end <= 0xfc00 && range.end > range.start,
    );
    assert.equal(range.bytes.length, range.end - range.start);
    assert.deepEqual(
      Buffer.from(drives[0]).subarray(range.start - CCP, range.end - CCP),
      Buffer.from(range.bytes),
      "A system records contain the supplied immutable BIOS range",
    );
  }
  assert.deepEqual(
    components.map(({ name }) => name).sort(),
    [...Object.keys(TOOL_FLOORS), ...PRIVATE_STACK_GAMES].sort(),
  );
  for (const component of components) {
    assert.ok(
      Number.isInteger(component.bytes) &&
        component.bytes > 0 &&
        component.bytes <= LOAD_BYTES,
    );
    assert.match(component.sha256, /^[0-9a-f]{64}$/);
  }
  const originalHashes = drives.map(hash);
  const evidence =
    evidenceDirectory ??
    (await mkdtemp(join(tmpdir(), "triptych-large-ab-apps-")));
  const bootstrapPath = join(evidence, "bootstrap.bin");
  await writeFile(bootstrapPath, bootstrap);
  const retained = new Map();
  async function retain(bytes) {
    const digest = hash(bytes);
    if (!retained.has(digest)) {
      const path = join(evidence, `${digest}.img`);
      await writeFile(path, bytes);
      retained.set(digest, path);
    }
    return { sha256: digest, path: retained.get(digest) };
  }
  function withDisk(bytes, action) {
    const disk = new CpmDisk(bytes);
    try {
      return action(disk);
    } finally {
      disk.free();
    }
  }
  function verifyPins(bytes) {
    withDisk(bytes, (disk) => {
      assert.equal(disk.geometry_id(), "triptych-cpm-8m-v1");
      for (const component of components) {
        const contents = Buffer.from(disk.read_file(component.name));
        assert.equal(contents.length, Math.ceil(component.bytes / 128) * 128);
        assert.equal(
          hash(contents.subarray(0, component.bytes)),
          component.sha256,
          `${component.name} release identity`,
        );
      }
    });
  }
  for (const bytes of drives) verifyPins(bytes);
  const exact = Buffer.alloc(LOAD_BYTES);
  exact[0] = 0xc9; // RET preserves and consumes the CCP's real warm-boot word.
  const oversized = Buffer.alloc(LOAD_BYTES + 128, 0x76);
  let current = drives.map((bytes, drive) =>
    withDisk(bytes, (disk) => {
      for (const [name, contents] of [
        ["SIDE.TXT", `DRIVE-${drive ? "B" : "A"}-ORIGINAL\r\n`],
        ["END.TXT", "AB-PROOF-END"],
        [
          "HELLO.ASM",
          'ORG $0100\nLD DE,MESSAGE\nLD C,9\nCALL 5\nRET\nMESSAGE: DB "Hello from ATOM",13,10,36\n',
        ],
        [
          "INPUT.NU",
          "sub main() fails\n    writeOutputByte('O') else fail\n    writeOutputByte('K') else fail\nend\n",
        ],
        ["BAD.ASM", "ORG $0100\nTHIS_IS_NOT_AN_INSTRUCTION\n"],
        ["BAD.NU", "this is not a Nucleus program\n"],
        ["FIT.COM", exact],
        ["OVER.COM", oversized],
      ])
        disk.add_import(
          name,
          typeof contents === "string"
            ? Buffer.from(contents, "ascii")
            : contents,
        );
      return Buffer.from(disk.export_candidate());
    }),
  );
  const seededA = hash(current[0]);
  const systemAreas = current.map((bytes) =>
    Buffer.from(bytes.subarray(0, 16_384)),
  );
  const reports = [];

  async function wasmSession(session, input) {
    const machine = new TriptychCpu(bootstrap);
    input.forEach((bytes, drive) => machine.install_drive(drive, bytes, true));
    let transcript = Buffer.alloc(0),
      active,
      pending,
      awaitingReload = true,
      guardsInstalled = false;
    let minimumBdosSp = resident.bdosStackTop;
    const executions = [],
      checkpoints = [];
    const immutable = (includeCcp) => {
      assert.deepEqual(
        Buffer.from(machine.read_ram(BDOS, resident.bdosWritableStart - BDOS)),
        Buffer.from(resident.bdosBytes).subarray(
          0,
          resident.bdosWritableStart - BDOS,
        ),
        "live BDOS code/table bytes",
      );
      for (const range of resident.biosImmutableRanges)
        assert.deepEqual(
          Buffer.from(machine.read_ram(range.start, range.end - range.start)),
          Buffer.from(range.bytes),
          "live BIOS immutable bytes",
        );
      if (includeCcp) {
        assert.deepEqual(
          Buffer.from(machine.read_ram(CCP, resident.ccpWritableStart - CCP)),
          Buffer.from(resident.ccpBytes).subarray(
            0,
            resident.ccpWritableStart - CCP,
          ),
          "restored CCP code",
        );
        assert.deepEqual(
          Buffer.from(
            machine.read_ram(
              resident.ccpStackGuardStart,
              resident.ccpStackGuardEnd - resident.ccpStackGuardStart,
            ),
          ),
          Buffer.from(resident.ccpBytes).subarray(
            resident.ccpStackGuardStart - CCP,
            resident.ccpStackGuardEnd - CCP,
          ),
          "CCP stack guard",
        );
      }
      if (guardsInstalled)
        for (const address of GUARDS)
          assert.equal(
            machine.read_ram(address, 1)[0],
            0x59,
            "ALV boundary guard",
          );
    };
    function observe() {
      const state = machine.cpu_state();
      let pc, sp, c;
      try {
        pc = state.pc();
        sp = state.sp();
        c = state.c();
      } finally {
        state.free();
      }
      if (pc >= BDOS && sp >= BDOS && sp < BIOS) {
        assert.ok(
          sp >= resident.bdosStackBase && sp <= resident.bdosStackTop,
          `resident stack ${sp.toString(16)}`,
        );
        minimumBdosSp = Math.min(minimumBdosSp, sp);
      }
      if (awaitingReload && pc === CCP) {
        assert.deepEqual(
          Buffer.from(machine.read_ram(CCP, 2048)),
          Buffer.from(resident.ccpBytes),
          "full CCP restored before its first instruction",
        );
        assert.deepEqual(
          Buffer.from(machine.read_ram(BDOS, 3584)),
          Buffer.from(resident.bdosBytes),
          "full BDOS restored before CCP entry",
        );
        awaitingReload = false;
        if (executions.length) executions.at(-1).residentReloadObserved = true;
      }
      if (pending && pc === 0x100) {
        assert.ok(!pending.rejectLaunch, "oversized COM must never execute");
        assert.ok(
          sp >= 0xe400 && sp + 2 <= BDOS,
          "launch return word lies above tool E400 stacks",
        );
        assert.equal(
          Buffer.from(machine.read_ram(sp, 2)).readUInt16LE(),
          0,
          "CCP installs warm-boot return word",
        );
        assert.deepEqual(
          Buffer.from(machine.read_ram(0x100, pending.fileBytes.length)),
          pending.fileBytes,
          "actual loaded COM bytes",
        );
        active = {
          name: pending.launch,
          entryPc: pc,
          entrySp: sp,
          minimumAppSp: sp,
          sawE400: false,
        };
        pending = undefined;
      }
      if (PRIVATE_STACK_GAMES.has(active?.name) && pc === 5 && c === 0) {
        immutable(false);
        assert.equal(
          machine.read_ram(4, 1)[0],
          1,
          `${active.name} exit retains B`,
        );
        active.returnPc = pc;
        active.returnSp = sp;
        active.exitMethod = "BDOS function 0";
        active.driveAtWarmBoot = 1;
        executions.push(active);
        active = undefined;
        awaitingReload = true;
      }
      if (active) {
        assert.ok(
          pc < CCP || pc >= BDOS,
          "transient must not execute overwritten CCP code",
        );
        if (pc >= 0x100 && pc < CCP) {
          active.minimumAppSp = Math.min(active.minimumAppSp, sp);
          active.sawE400 ||= sp === 0xe400;
          // The games reserve a 512-byte stack at the end of each COM;
          // the other tools use high TPA stack arenas.
          const floor = PRIVATE_STACK_GAMES.has(active.name)
            ? 0x0100 +
              components.find((c) => c.name === active.name).bytes -
              512
            : TOOL_FLOORS[active.name];
          if (floor && sp < 0xe400)
            assert.ok(sp >= floor, `${active.name} stack floor`);
        }
        if (pc === 0 && !machine.boot_rom_enabled()) {
          assert.equal(
            sp,
            active.entrySp + 2,
            `${active.name} restores caller SP and RET reaches zero`,
          );
          assert.equal(
            Buffer.from(machine.read_ram(active.entrySp, 2)).readUInt16LE(),
            0,
            "saved return word survives tool lifetime",
          );
          immutable(false);
          if (TOOL_FLOORS[active.name])
            assert.equal(
              active.sawE400,
              true,
              `${active.name} uses unchanged E400 stack`,
            );
          active.returnPc = pc;
          active.returnSp = sp;
          active.driveAtWarmBoot = machine.read_ram(4, 1)[0];
          assert.equal(
            active.driveAtWarmBoot,
            1,
            "tool return retains drive B",
          );
          active.deadCcpBytesChanged = !Buffer.from(
            machine.read_ram(CCP, 256),
          ).equals(Buffer.from(resident.ccpBytes).subarray(0, 256));
          if (TOOL_FLOORS[active.name])
            assert.equal(
              active.deadCcpBytesChanged,
              true,
              "pinned-tool stack demonstrably overwrites dead CCP bytes",
            );
          executions.push(active);
          active = undefined;
          awaitingReload = true;
        }
      }
    }
    try {
      for (const item of session.steps) {
        const before = transcript.length;
        const executionCount = executions.length;
        if (item.launch || item.rejectLaunch) {
          assert.equal(active, undefined);
          pending = {
            ...item,
            fileBytes: item.launch
              ? withDisk(
                  Buffer.from(machine.export_drive_checkpoint(1)),
                  (disk) => Buffer.from(disk.read_file(item.launch)),
                )
              : undefined,
          };
        }
        assert.ok(
          machine.enqueue_serial_input(Buffer.from(item.input, "latin1")),
        );
        const deadline = Date.now() + 120_000;
        let reached = false,
          instructions = 0;
        for (let chunk = 0; chunk < 200_000; chunk++) {
          const traced = Boolean(active || pending || awaitingReload);
          if (traced) {
            for (let count = 0; count < 256; count++) {
              observe();
              machine.step(false);
            }
            instructions += 256;
          } else {
            machine.run_slice(10_000, 100_000);
            instructions += Number(machine.last_steps());
          }
          assert.equal(
            machine.last_halted(),
            false,
            `${session.id}/${item.id}: unexpected HALT`,
          );
          transcript = Buffer.concat([
            transcript,
            Buffer.from(machine.take_serial_output()),
          ]);
          const fresh = transcript.subarray(before);
          const required =
            item.required === undefined ||
            (item.required instanceof RegExp
              ? item.required.test(fresh.toString("latin1"))
              : fresh.includes(Buffer.from(item.required, "latin1")));
          if (
            fresh.length &&
            transcript
              .subarray(-item.suffix.length)
              .equals(Buffer.from(item.suffix, "latin1")) &&
            required
          ) {
            reached = true;
            break;
          }
          assert.ok(
            Date.now() < deadline && instructions < 50_000_000,
            `${session.id}/${item.id}: bounded execution expired: ${fresh.toString("latin1")}`,
          );
          if (chunk % 256 === 0)
            await new Promise((done) => setTimeout(done, 0));
        }
        assert.ok(reached, `${session.id}/${item.id}: output boundary absent`);
        if (!item.staysOpen) {
          assert.equal(active, undefined, `${item.id}: transient returned`);
          assert.equal(
            awaitingReload,
            false,
            `${item.id}: warm reload reached CCP`,
          );
          if (item.launch) assert.equal(executions.length, executionCount + 1);
          pending = undefined;
        }
        if (!guardsInstalled) {
          for (const address of GUARDS)
            machine.write_ram(address, Uint8Array.of(0x59));
          guardsInstalled = true;
        }
        immutable(!active);
        assert.ok(
          machine.disk_management_ready(),
          `${session.id}/${item.id}: all mounted drives flushed`,
        );
        const snapshots = [];
        for (const drive of [0, 1]) {
          const bytes = Buffer.from(machine.export_drive_checkpoint(drive));
          assert.equal(bytes.length, IMAGE_BYTES);
          assert.deepEqual(
            bytes,
            Buffer.from(machine.export_drive(drive)),
            "checkpoint equals complete live backing",
          );
          assert.deepEqual(
            bytes.subarray(0, 16_384),
            systemAreas[drive],
            "saved system bytes preserved",
          );
          verifyPins(bytes);
          snapshots.push(await retain(bytes));
        }
        assert.equal(
          snapshots[0].sha256,
          seededA,
          "all workflows preserve whole A image",
        );
        const transcriptPath = join(
          evidence,
          `${session.id}-${item.id}.console`,
        );
        await writeFile(transcriptPath, transcript);
        checkpoints.push({
          id: item.id,
          input: item.input,
          transcript: Buffer.from(transcript),
          transcriptPath,
          snapshots,
        });
        console.log(`${session.id}/${item.id}: WASM boundary passed`);
      }
      for (const execution of executions)
        assert.equal(execution.residentReloadObserved, true);
      return {
        checkpoints,
        executions,
        maximumBdosStackBytes: resident.bdosStackTop - minimumBdosSp,
      };
    } finally {
      machine.free();
    }
  }

  for (const session of scenarios()) {
    const initial = await Promise.all(current.map(retain));
    const wasm = await wasmSession(session, current);
    const nativePaths = [0, 1].map((drive) =>
      join(evidence, `${session.id}-native-${drive}.img`),
    );
    await Promise.all(
      nativePaths.map((path, drive) => writeFile(path, current[drive])),
    );
    await nativeSession(bootstrapPath, nativePaths, session, wasm.checkpoints);
    current = await Promise.all(
      wasm.checkpoints.at(-1).snapshots.map(({ path }) => readFile(path)),
    );
    if (session.readOnly)
      assert.deepEqual(
        current.map(hash),
        initial.map(({ sha256 }) => sha256),
        "fresh reopen is byte-preserving on both drives",
      );
    reports.push({
      id: session.id,
      initial,
      executions: wasm.executions,
      maximumBdosStackBytes: wasm.maximumBdosStackBytes,
      checkpoints: wasm.checkpoints.map(({ transcript, ...checkpoint }) => ({
        ...checkpoint,
        transcriptSha256: hash(transcript),
        terminal: screen(transcript),
      })),
    });
  }
  withDisk(current[0], (disk) =>
    assert.match(
      Buffer.from(disk.read_file("INPUT.NU")).toString(),
      /writeOutputByte\('O'\)/,
    ),
  );
  withDisk(current[1], (disk) => {
    assert.match(
      Buffer.from(disk.read_file("INPUT.NU")).toString(),
      /writeOutputByte\('Y'\)/,
    );
    assert.ok(
      !disk.file_names().includes("BAD.COM"),
      "compiler failures publish no COM",
    );
  });
  assert.deepEqual(
    drives.map(hash),
    originalHashes,
    "caller input images remain exact",
  );
  const result = {
    status: "passed",
    scope:
      "two-drive E300/EB00/F900 host integration, exact native/WASM bytes and terminal state, basic pinned-tool success/error lifetimes and fresh reopen",
    limits: [
      "not browser drive-set persistence or ESP32 qualification",
      "maximum admitted tool buffers/capacity failures and generated-program failure/trap lifetimes require separate qualification",
      "instruction-level PC/SP and RAM observations are WASM measurements; native comparison covers observable console and complete images",
    ],
    bootstrapSha256: hash(bootstrap),
    inputDriveSha256: originalHashes,
    residentSha256: {
      ccp: hash(resident.ccpBytes),
      bdos: hash(resident.bdosBytes),
    },
    components,
    profile: {
      ccp: CCP,
      bdos: BDOS,
      bios: BIOS,
      loadBytes: LOAD_BYTES,
      toolStackTop: 0xe400,
    },
    evidence,
    sessions: reports,
  };
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}

async function nativeSession(bootstrapPath, diskPaths, session, checkpoints) {
  const child = spawn(
    join(root, "target/debug/triptych-host-native"),
    [
      "--stop-after",
      endSuffix,
      "--max-steps",
      "1000000000",
      bootstrapPath,
      ...diskPaths,
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let transcript = Buffer.alloc(0),
    stderr = "",
    failure,
    closed = false;
  child.stdout.on("data", (bytes) => {
    transcript = Buffer.concat([transcript, bytes]);
  });
  child.stderr.on("data", (bytes) => {
    stderr += bytes.toString();
  });
  child.on("error", (error) => {
    failure = error;
  });
  child.stdin.on("error", (error) => {
    failure ??= error;
  });
  const completion = new Promise((done) =>
    child.on("close", (code, signal) => {
      closed = true;
      done({ code, signal });
    }),
  );
  function waitFor(length, id) {
    return new Promise((done, reject) => {
      let finished = false;
      const timeout = setTimeout(
        () =>
          finish(new Error(`${session.id}/${id}: native timeout: ${stderr}`)),
        120_000,
      );
      function finish(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        child.stdout.off("data", changed);
        child.off("close", changed);
        child.off("error", changed);
        error ? reject(error) : done();
      }
      function changed() {
        if (failure) finish(failure);
        else if (transcript.length >= length) finish();
        else if (closed)
          finish(
            new Error(`${session.id}/${id}: native early exit: ${stderr}`),
          );
      }
      child.stdout.on("data", changed);
      child.on("close", changed);
      child.on("error", changed);
      changed();
    });
  }
  try {
    for (const checkpoint of checkpoints) {
      if (checkpoint.input)
        child.stdin.write(Buffer.from(checkpoint.input, "latin1"));
      await waitFor(checkpoint.transcript.length, checkpoint.id);
      assert.deepEqual(
        transcript,
        checkpoint.transcript,
        `${session.id}/${checkpoint.id}: exact native console parity`,
      );
      assert.deepEqual(
        screen(transcript),
        screen(checkpoint.transcript),
        "terminal state parity",
      );
      for (const drive of [0, 1])
        assert.deepEqual(
          await readFile(diskPaths[drive]),
          await readFile(checkpoint.snapshots[drive].path),
          `${session.id}/${checkpoint.id}: whole drive ${drive} parity`,
        );
    }
    const timeout = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      assert.deepEqual(await completion, { code: 0, signal: null }, stderr);
    } finally {
      clearTimeout(timeout);
    }
    assert.deepEqual(transcript, checkpoints.at(-1).transcript);
  } finally {
    if (!closed) {
      child.kill("SIGKILL");
      await completion;
    }
  }
}
