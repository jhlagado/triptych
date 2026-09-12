import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";

// Isolated guest evidence only; consumes existing bindings and never builds.

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { CpmDisk, TriptychCpu } = require(
  join(root, "dist/wasm/triptych_host_wasm.js"),
);
const [directory, profileDirectory] = process.argv.slice(2);
assert.ok(
  directory,
  "Usage: node tools/prove-colossal-cave-image.mjs CANDIDATE_DIRECTORY [N04_QUALIFICATION_DIRECTORY]",
);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const image = await readFile(join(directory, "colossal-cave-350-r1.img"));
assert.equal(image.length, 2097152);
assert.equal(
  hash(image),
  "5dc331b1be3609cb72bb728d3f64b811d9aea95b8357c9cb3224d150596bad33",
);
const hostPath = join(root, "dist/wasm/triptych_host_wasm_bg.wasm");
const hostWasmSha256 = hash(await readFile(hostPath));
const system = await readFile(
  profileDirectory
    ? join(profileDirectory, "system.bin")
    : join(root, "dist/wasm-browser/system-triptych-cpm-2m-n04-v1.bin"),
);
const bootstrap = await readFile(
  profileDirectory
    ? join(profileDirectory, "bootstrap.bin")
    : join(root, "dist/wasm-browser/bootstrap-triptych-cpm-2m-n04-v1.bin"),
);
const deployment = JSON.parse(
  await readFile(
    profileDirectory
      ? join(profileDirectory, "descriptor.json")
      : join(root, "dist/wasm-browser/deployment-manifest.json"),
  ),
);
const profile = profileDirectory
  ? deployment
  : deployment.twoMibProfiles.find((p) => p.configuredCount === 4);
assert.equal(profile.configuredCount, 4);
assert.equal(profile.residentProfile, "triptych-cpu-v0.1-2m-n04");
assert.equal(
  profile.layout.ccp,
  0xe400,
  "224-page save is qualified only for N04",
);
assert.equal(system.length, 16384);
assert.equal(bootstrap.length, 256);
assert.equal(hash(system), profile.system.sha256);
assert.equal(hash(bootstrap), profile.bootstrap.sha256);
function blank() {
  const d = CpmDisk.create_two_mib();
  try {
    return Buffer.from(d.export_source());
  } finally {
    d.free();
  }
}
function machineFor(c, b, writable) {
  const a = blank();
  a.set(system);
  const machine = new TriptychCpu(bootstrap);
  machine.install_drive(0, a, false);
  machine.install_drive(1, b, true);
  machine.install_drive(2, c, writable);
  machine.install_drive(3, blank(), true);
  return machine;
}
function terminal(machine) {
  let transcript = "";
  function run() {
    // Bounded polling avoids injecting queued commands into BDOS input polls.
    for (let i = 0; i < 1000; i++) {
      machine.run_slice(50000, 500000);
      transcript += Buffer.from(machine.take_serial_output()).toString(
        "latin1",
      );
    }
  }
  run();
  assert.match(transcript, /A>$/);
  return {
    command(command, expected) {
      const start = transcript.length;
      assert.ok(machine.enqueue_serial_input(Buffer.from(command + "\r")));
      run();
      const output = transcript.slice(start);
      assert.match(output, expected, command);
      return output;
    },
    text: () => transcript,
  };
}
const results = [];
for (const writable of [false, true]) {
  const label = writable ? "writable-template" : "protected-software";
  const machine = machineFor(image, blank(), writable);
  const originalA = Buffer.from(machine.export_drive(0));
  const originalD = Buffer.from(machine.export_drive(3));
  let savedB, savedC;
  try {
    const t = terminal(machine);
    t.command("C:", /C>$/);
    t.command("DIR", /ADVENTUR COM : PHROGZ\s+DIN/);
    t.command("ADVENTUR", /WOULD YOU LIKE INSTRUCTIONS/);
    t.command("NO", /END OF A ROAD/);
    t.command("ENTER", /INSIDE A BUILDING/);
    t.command("TAKE KEYS", /OK/);
    t.command("INVENTORY", /SET OF KEYS/);
    t.command("SAVE", /IS THIS ACCEPTABLE/);
    t.command("YES", /SAVE YOUR CORE-IMAGE[\s\S]*C>$/);
    t.command(`SAVE 224 ${writable ? "" : "B:"}SAVED.COM`, /C>$/);
    savedB = Buffer.from(machine.export_drive_checkpoint(1));
    savedC = Buffer.from(machine.export_drive_checkpoint(2));
    const saved = new CpmDisk(writable ? savedC : savedB);
    try {
      assert.equal(saved.read_file("SAVED.COM").length, 224 * 256);
    } finally {
      saved.free();
    }
    if (!writable)
      assert.deepEqual(Buffer.from(machine.export_drive(2)), image);
    else assert.deepEqual(savedB, blank());
    assert.deepEqual(Buffer.from(machine.export_drive(0)), originalA);
    assert.deepEqual(Buffer.from(machine.export_drive(3)), originalD);
    await writeFile(join(directory, label + "-save.txt"), t.text());
  } finally {
    machine.free();
  }
  const restored = machineFor(savedC, savedB, writable);
  try {
    const t = terminal(restored);
    t.command("C:", /C>$/);
    t.command(writable ? "SAVED" : "B:SAVED", /INSIDE BUILDING/i);
    t.command("INVENTORY", /SET OF KEYS/);
    t.command("QUIT", /REALLY WANT TO QUIT/);
    t.command("YES", /C>$/);
    if (!writable) {
      t.command("SAVE 1 DENIED.COM", /Bdos Err On C: Bad Sector/);
      assert.deepEqual(Buffer.from(restored.export_drive(2)), image);
      const protectedDisk = new CpmDisk(restored.export_drive(2));
      try {
        assert.ok(!protectedDisk.file_names().includes("DENIED.COM"));
      } finally {
        protectedDisk.free();
      }
    }
    assert.deepEqual(Buffer.from(restored.export_drive(0)), originalA);
    assert.deepEqual(Buffer.from(restored.export_drive(3)), originalD);
    await writeFile(join(directory, label + "-restore.txt"), t.text());
    results.push({
      mode: label,
      coldRestore: true,
      inventoryPreserved: true,
      quitToCcp: true,
      protectedSystemUnchanged: true,
      spareDriveUnchanged: true,
    });
  } finally {
    restored.free();
  }
}
const evidence = {
  imageSha256: hash(image),
  hostWasmSha256,
  systemSha256: hash(system),
  bootstrapSha256: hash(bootstrap),
  profile: profile.targetProfile ?? "triptych-cpu-v0.1-2m-n04",
  results,
  scope:
    "Isolated WASM guest; no browser persistence, hosted fetch or publication tested",
};
await writeFile(
  join(directory, "qualification.json"),
  JSON.stringify(evidence, null, 2) + "\n",
);
console.log(JSON.stringify(evidence));
