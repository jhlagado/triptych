// Machine-level proof only: consumes an existing build, never builds or serves.
// Run: node tools/prove-disk-library-games.mjs
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateDiskCatalogue } from "../crates/triptych-host-wasm/web/disk-catalogue.js";

const root = resolve(import.meta.dirname, "..");
const assets = resolve(root, "dist/wasm-browser");
const { TriptychCpu, CpmDisk } = createRequire(import.meta.url)(
  resolve(root, "dist/wasm/triptych_host_wasm.js"),
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const deployment = await json(resolve(assets, "deployment-manifest.json"));
const catalogue = validateDiskCatalogue(
  await json(resolve(assets, "disk-catalogue.json")),
);
const profile = deployment.twoMibProfiles.find(
  (p) => p.residentProfile === "triptych-cpu-v0.1-2m-n04",
);
assert.equal(profile.configuredCount, 4);
assert.equal(profile.layout.ccp, 0xe400);
const bootstrap = await readFile(resolve(assets, profile.bootstrap.asset));
assert.equal(bootstrap.length, 256);
assert.equal(hash(bootstrap), profile.bootstrap.sha256);
const image = async (id) => {
  const row = catalogue.images.find((entry) => entry.id === id);
  assert(row);
  const bytes = await readFile(resolve(assets, row.asset));
  assert.equal(bytes.length, row.byteLength);
  assert.equal(hash(bytes), row.sha256);
  return { row, bytes };
};
const system = await image("system-2m-n04");
const games = await image("games-2m");
assert.equal(system.row.systemProfile, profile.residentProfile);
assert.equal(games.row.systemProfile, null);
assert.equal(hash(system.bytes.subarray(0, 16384)), profile.system.sha256);
const blank = CpmDisk.create_two_mib();
const blankBytes = blank.export_candidate();
blank.free();
const names = (bytes) => {
  const disk = new CpmDisk(bytes);
  try {
    return disk.file_names().sort();
  } finally {
    disk.free();
  }
};

async function prove(game, direct) {
  const source =
    game === "CAVERNS"
      ? "caverns80"
      : game === "HYPERDRV"
        ? "hyperdrive"
        : "hyperdrive2";
  const manifest = await json(
    resolve(root, `third_party/${source}/manifest.json`),
  );
  const disk = new CpmDisk(games.bytes);
  try {
    assert.equal(
      hash(disk.read_file(`${game}.COM`).subarray(0, manifest.bytes)),
      manifest.sha256,
    );
  } finally {
    disk.free();
  }
  // The pinned complete allocation includes fixed workspace and the stack,
  // unlike a comparison of COM length alone. Execution below exercises N4 too.
  assert.equal(manifest.memory.dynamicAllocationBytes, 0);
  assert(manifest.memory.endExclusive <= profile.layout.ccp);
  assert(manifest.memory.stackEndExclusive <= manifest.memory.endExclusive);
  const cpu = new TriptychCpu(bootstrap);
  let transcript = "",
    steps = 0,
    sampledMinSp = 65535;
  const samples = [];
  const wait = (pattern) => {
    const start = transcript.length;
    for (let i = 0; i < 3000; i++) {
      const reason = cpu.run_slice(20000, 300000);
      steps += Number(cpu.last_steps());
      transcript += Buffer.from(cpu.take_serial_output()).toString("ascii");
      const state = cpu.cpu_state();
      sampledMinSp = Math.min(sampledMinSp, state.sp());
      state.free();
      if (pattern.test(transcript.slice(start))) return transcript.slice(start);
      assert.notEqual(reason, 0, `unexpected HALT: ${transcript.slice(-800)}`);
    }
    throw new Error(`waiting for ${pattern}: ${transcript.slice(-1200)}`);
  };
  const send = (text) =>
    assert(cpu.enqueue_serial_input(Buffer.from(text, "ascii")));
  const command = (text, pattern) => {
    send(`${text}\r`);
    return wait(pattern);
  };
  const sample = (label) => {
    const state = cpu.cpu_state();
    try {
      samples.push({
        label,
        pc: state.pc(),
        sp: state.sp(),
        currentDrive: cpu.read_ram(4, 1)[0],
      });
    } finally {
      state.free();
    }
  };
  const protectedUnchanged = () => {
    assert.equal(hash(cpu.export_drive(0)), system.row.sha256);
    assert.equal(hash(cpu.export_drive(2)), games.row.sha256);
  };
  try {
    cpu.install_drive(0, system.bytes, false);
    cpu.install_drive(1, direct ? blankBytes : games.bytes, true);
    cpu.install_drive(2, games.bytes, false);
    cpu.install_drive(3, blankBytes, true);
    wait(/A>\s*$/);
    assert.equal(cpu.boot_rom_enabled(), false);
    const letter = direct ? "D" : "B",
      target = direct ? 3 : 1;
    command(`${letter}:`, new RegExp(`${letter}>\\s*$`));
    const launch = () => {
      command(
        direct ? `C:${game}` : game,
        ["CAVERNS", "HYPERD2"].includes(game)
          ? /\[Space\/Enter: more, Q: skip\]/
          : /\?\s*$/,
      );
      if (["CAVERNS", "HYPERD2"].includes(game)) {
        send("q");
        wait(/\?\s*$/);
      }
      assert.equal(
        cpu.read_ram(4, 1)[0],
        target,
        "CCP preserves the selected writable drive",
      );
      sample("game prompt");
    };
    const quit = () => {
      command(
        "QUIT",
        game === "CAVERNS"
          ? /Another adventure\?/
          : game === "HYPERDRV"
            ? /Return to CP\/M\? \(Y\/N\)/
            : /Quit to CP\/M\?/,
      );
      command(game === "CAVERNS" ? "N" : "Y", new RegExp(`${letter}>\\s*$`));
    };
    launch();
    const inventory = () =>
      command("INVENTORY", /\?\s*$/)
        .replace(/\r/g, "")
        .trim();
    const initialInventory = inventory();
    const marker =
      game === "HYPERD2" ? /stand beside the docking bay/i : /compass/i;
    if (game === "HYPERD2") command("N", /\?\s*$/);
    else {
      assert.doesNotMatch(initialInventory, /compass/i);
      command("TAKE COMPASS", /\?\s*$/);
    }
    const savedInventory =
      game === "HYPERD2" ? command("LOOK", /\?\s*$/) : inventory();
    assert.match(savedInventory, marker);
    // Observe the unused region without injecting canaries or altering RAM.
    // Compare only while the game remains loaded; CCP legitimately uses RAM.
    const gapStart = Math.ceil(manifest.memory.endExclusive / 128) * 128;
    const gap = cpu.read_ram(gapStart, profile.layout.ccp - gapStart);
    command("SAVE", /Game saved[\s\S]*\?\s*$/);
    assert.deepEqual(
      cpu.read_ram(gapStart, gap.length),
      gap,
      "SAVE stays inside declared application memory",
    );
    sample("saved");
    command(game === "HYPERD2" ? "S" : "DROP COMPASS", /\?\s*$/);
    const changedInventory =
      game === "HYPERD2" ? command("LOOK", /\?\s*$/) : inventory();
    assert.doesNotMatch(changedInventory, marker);
    assert.notEqual(changedInventory, savedInventory);
    command("LOAD", /Game loaded[\s\S]*\?\s*$/);
    const restoredInventory =
      game === "HYPERD2" ? command("LOOK", /\?\s*$/) : inventory();
    if (game === "HYPERD2")
      assert.match(
        restoredInventory,
        marker,
        "LOAD restores changed game state",
      );
    else
      assert.equal(
        restoredInventory,
        savedInventory,
        "LOAD restores the carried compass after DROP",
      );
    quit();
    const saved = cpu.export_drive_checkpoint(target);
    if (direct) assert.deepEqual(names(saved), [`${game}.SAV`]);
    else assert(names(saved).includes(`${game}.SAV`));
    assert.deepEqual(names(cpu.export_drive(direct ? 1 : 3)), []);
    assert.deepEqual(cpu.export_drive(direct ? 1 : 3), blankBytes);
    protectedUnchanged();
    launch();
    if (game !== "HYPERD2")
      assert.doesNotMatch(
        inventory(),
        /compass/i,
        "relaunch starts a new game",
      );
    const loadGap = cpu.read_ram(gapStart, profile.layout.ccp - gapStart);
    command("LOAD", /Game loaded[\s\S]*\?\s*$/);
    assert.deepEqual(
      cpu.read_ram(gapStart, loadGap.length),
      loadGap,
      "LOAD stays inside declared application memory",
    );
    sample("loaded");
    const relaunched =
      game === "HYPERD2" ? command("LOOK", /\?\s*$/) : inventory();
    if (game === "HYPERD2")
      assert.match(
        relaunched,
        marker,
        "LOAD restores saved state after relaunch",
      );
    else
      assert.equal(
        relaunched,
        savedInventory,
        "LOAD restores the saved inventory after relaunch",
      );
    quit();
    assert.deepEqual(
      cpu.export_drive_checkpoint(target),
      saved,
      "LOAD does not modify saved media",
    );
    protectedUnchanged();
    return {
      game,
      mode: direct ? "D: then C:game" : "writable B copy",
      passed: true,
      executableSha256: manifest.sha256,
      memory: manifest.memory,
      sampledMinSp,
      steps,
      samples,
      gameplayRestore: {
        commands:
          game === "HYPERD2"
            ? ["N", "SAVE", "S", "LOAD"]
            : ["TAKE COMPASS", "SAVE", "DROP COMPASS", "LOAD"],
        initialInventory,
        savedInventory,
        changedInventory,
        restoredInventory,
      },
      saveDrive: letter,
      saveFiles: names(saved),
      saveDiskSha256: hash(saved),
    };
  } catch (error) {
    protectedUnchanged();
    return {
      game,
      mode: direct ? "D: then C:game" : "writable B copy",
      passed: false,
      error: error.message,
      steps,
      samples,
      terminal: transcript.slice(-1500),
      bFiles: names(cpu.export_drive(1)),
      dFiles: names(cpu.export_drive(3)),
    };
  } finally {
    cpu.free();
  }
}

const results = [];
for (const game of ["CAVERNS", "HYPERDRV", "HYPERD2"]) {
  const direct = await prove(game, true);
  results.push(direct);
  if (!direct.passed) results.push(await prove(game, false));
}
console.log(
  JSON.stringify(
    {
      schema: "triptych-disk-library-games-proof-v1",
      scope:
        "Node WASM CPU execution; not browser or ESP32; sampled stack, not exhaustive high-water proof",
      machine: deployment.distribution.triptych,
      profile: profile.residentProfile,
      bootstrapSha256: hash(bootstrap),
      systemSha256: system.row.sha256,
      gamesSha256: games.row.sha256,
      results,
    },
    null,
    2,
  ),
);
if (results.some((result) => !result.passed)) process.exitCode = 1;
