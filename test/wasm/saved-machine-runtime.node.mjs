import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import test from "node:test";
import { prepareSavedMachineRuntime } from "../../crates/triptych-host-wasm/web/saved-machine-runtime.js";

const hash = "a".repeat(64);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const legacy = (profile = "legacy-e400", withB = false) => ({
  bootstrap: { profile, bytes: new Uint8Array(256).fill(42) },
  drives: {
    A: {
      name: "A.img",
      bytes: new Uint8Array(profile === "legacy-e400" ? 512 : 8388608).fill(1),
    },
    B: withB ? { name: "B.img", bytes: new Uint8Array(8388608).fill(2) } : null,
  },
});

// Synthetic closed metadata qualifies saved admission, not fresh bootability.
function fixture(count, full = false) {
  const n = `n${String(count).padStart(2, "0")}`;
  const profile = `triptych-cpu-v0.1-2m-${n}`;
  const allocationBytes = 256 * Math.ceil(count / 2);
  const allocationBase = 65536 - allocationBytes;
  const bios = allocationBase - 1024;
  const bdos = bios - 3584;
  const ccp = bdos - 2048;
  const source = (path) => ({
    source: path,
    sourceSha256: hash,
    preparedSourceSha256: hash,
  });
  const root = "third_party/portable-cpm/2m/v0.1.4";
  const bytes = new Uint8Array(256).fill(count);
  const descriptor = {
    schema: "triptych-two-mib-system-v1",
    id: "triptych-cpm-2m-v1",
    residentProfile: profile,
    configuredCount: count,
    imageBytes: 2097152,
    systemBytes: 16384,
    layout: {
      ccp,
      bdos,
      bios,
      allocationBase,
      allocationBytes,
      commonLimit: bios + 768,
      dphBase: bios + 768,
      dphEnd: bios + 768 + 16 * count,
    },
    system: {
      asset: `system-triptych-cpm-2m-${n}-v1.bin`,
      bytes: 16384,
      sha256: hash,
    },
    bootstrap: {
      asset: `bootstrap-triptych-cpm-2m-${n}-v1.bin`,
      bytes: 256,
      sha256: sha(bytes),
      ...source("roms/cpu/bootstrap-2m.asm"),
    },
    residents: {
      lock: `distribution/residents-2m/${n}.lock.json`,
      lockSha256: hash,
      manifest: `${root}/profiles/${profile}/manifest.json`,
      manifestSha256: hash,
      repository: "https://github.com/jhlagado/portable-cpm.git",
      version: "0.1.4",
      revision: "d28fc52774c967d1422b3b814d51c069247504c1",
      ccp: {
        ...source(`${root}/src/ccp.asm`),
        sha256: hash,
        offset: 0,
        origin: ccp,
        bytes: 2048,
      },
      bdos: {
        ...source(`${root}/src/bdos.asm`),
        sha256: hash,
        offset: 2048,
        origin: bdos,
        bytes: 3584,
      },
    },
    bios: {
      ...source("system/cpm/bios-2m.asm"),
      sha256: hash,
      dpb: bios + 500,
      directoryBuffer: bios + 515,
      checksumVector: bios + 643,
      commonEnd: bios + 675,
    },
    atom: {
      repository: "https://github.com/jhlagado/atom.git",
      revision: "802b5c2d320bec777f427755ff2d7338e3b80a05",
      package: "atom-z80",
      seed: {
        bytes: 64236,
        sha256:
          "fdea19fbd8aeb6211469f043491610455a71547902cf451c3e684e49a8fa0fd6",
      },
      packageIntegrity: `sha512-${"A".repeat(86)}==`,
    },
    machine: {
      revision: "b".repeat(40),
      dirty: true,
      generator: "tools/lib/cpm-two-mib-profile.mjs",
      generatorSha256: hash,
    },
  };
  return {
    snapshot: {
      schema: "triptych-drive-set-v4",
      configuredCount: count,
      bootstrap: { profile, bytes },
      slots: Array.from({ length: count }, (_, i) =>
        i !== 0 && i !== count - 1 && !full
          ? null
          : {
              instanceId: `550e8400-e29b-41d4-a716-${String(i).padStart(12, "0")}`,
              name: `${i}.img`,
              bytes: new Uint8Array(2097152).fill(i + 1),
            },
      ),
    },
    deployment: {
      schema: "triptych-browser-deployment-v1",
      twoMibProfiles: [descriptor],
      assets: ["system", "bootstrap"].map((kind) => ({
        path: descriptor[kind].asset,
        bytes: descriptor[kind].bytes,
        sha256: descriptor[kind].sha256,
      })),
    },
  };
}

function cpuDouble({ fail, onInstall } = {}) {
  const events = [],
    instances = [];
  class Cpu {
    constructor(bytes) {
      events.push("construct");
      if (fail === "construct") throw Error(fail);
      this.bootstrap = bytes.slice();
      this.drives = new Map();
      this.freed = 0;
      instances.push(this);
    }
    install_drive(index, bytes, writable) {
      events.push(`install:${index}:${writable}`);
      if (fail === `install:${index}`) throw Error(fail);
      this.drives.set(index, {
        live: bytes.slice(),
        checkpoint: bytes.slice(),
        writable,
        count: 0,
      });
      onInstall?.(index);
    }
    reset() {
      events.push("reset");
      if (fail === "reset") throw Error(fail);
    }
    step() {
      assert.fail("preparation must not step");
    }
    run_slice() {
      assert.fail("preparation must not run");
    }
    export_drive() {
      assert.fail("must not export unacknowledged backing");
    }
    export_drive_checkpoint(index) {
      return this.drives.get(index).checkpoint.slice();
    }
    drive_flush_count(index) {
      return this.drives.get(index).count;
    }
    free() {
      this.freed++;
      events.push("free");
    }
  }
  return { TriptychCpu: Cpu, instances, events };
}

async function prepare(f, double = cpuDouble(), options = {}) {
  return prepareSavedMachineRuntime({
    ...f,
    TriptychCpu: double.TriptychCpu,
    crypto: webcrypto,
    ...options,
  });
}

for (let count = 1; count <= 16; count++)
  test(`prepares configured count ${count}, retaining exact sparse indices and metadata`, async () => {
    const f = fixture(count, count === 16);
    const double = cpuDouble();
    const runtime = await prepare(f, double);
    const cpu = runtime.cpu;
    assert.deepEqual(
      [...cpu.drives.keys()],
      f.snapshot.slots.flatMap((s, i) => (s ? [i] : [])),
    );
    assert.equal(runtime.media.configuredCount, count);
    assert.equal(runtime.media.profile, f.snapshot.bootstrap.profile);
    assert.deepEqual(
      runtime.media.slots,
      f.snapshot.slots.map((s) =>
        s ? { name: s.name, instanceId: s.instanceId } : null,
      ),
    );
    assert(Object.isFrozen(runtime.media));
    assert(Object.isFrozen(runtime.media.slots));
    for (const slot of runtime.media.slots)
      if (slot) assert(Object.isFrozen(slot));
    assert.deepEqual(runtime.captureCheckpoint(), f.snapshot);
    assert.deepEqual(runtime.flushCounts(), Array(count).fill(0));
    assert.equal(double.events.at(-1), "reset");
    assert.equal(double.events.filter((x) => x === "reset").length, 1);
    assert([...cpu.drives.values()].every((drive) => drive.writable === false));
    runtime.dispose();
    runtime.dispose();
    assert.equal(cpu.freed, 1);
    assert.throws(() => runtime.cpu, /disposed/);
    assert.throws(() => runtime.captureCheckpoint(), /disposed/);
    assert.throws(() => runtime.flushCounts(), /disposed/);
  });

test("sparse A/P capture exports only acknowledged per-drive bytes and keeps identities", async () => {
  const f = fixture(16);
  const runtime = await prepare(f, cpuDouble(), { writable: true });
  const cpu = runtime.cpu;
  assert.deepEqual([...cpu.drives.keys()], [0, 15]);
  const p = cpu.drives.get(15);
  assert.equal(p.writable, true);
  p.live[0] = 73;
  assert.deepEqual(runtime.captureCheckpoint(), f.snapshot);
  p.checkpoint = p.live.slice();
  p.count = 1;
  p.live[1] = 99;
  const saved = runtime.captureCheckpoint();
  assert.equal(saved.slots[15].bytes[0], 73);
  assert.equal(saved.slots[15].bytes[1], 16);
  assert.deepEqual(saved.slots[0], f.snapshot.slots[0]);
  assert.deepEqual(runtime.flushCounts(), [...Array(15).fill(0), 1]);
  saved.slots[15].bytes.fill(0);
  saved.bootstrap.bytes.fill(0);
  assert.equal(runtime.captureCheckpoint().slots[15].bytes[0], 73);
  assert.deepEqual(runtime.captureCheckpoint().bootstrap, f.snapshot.bootstrap);
  runtime.dispose();
});

for (const [profile, withB, configuredCount] of [
  ["legacy-e400", false, 1],
  ["triptych-cpu-v0.1-8m-a", false, 1],
  ["triptych-cpu-v0.1-8m-ab", false, 2],
  ["triptych-cpu-v0.1-8m-ab", true, 2],
])
  test(`historical ${profile}, B=${withB} preserves its exact unwrapped shape`, async () => {
    const snapshot = legacy(profile, withB),
      double = cpuDouble();
    const runtime = await prepare({ snapshot }, double);
    assert.deepEqual(runtime.captureCheckpoint(), snapshot);
    assert.equal(runtime.media.configuredCount, configuredCount);
    assert.equal(Object.hasOwn(runtime.captureCheckpoint(), "schema"), false);
    assert.deepEqual(runtime.flushCounts(), Array(configuredCount).fill(0));
    runtime.dispose();
  });

test("input and descriptor mutation during admission cannot change the prepared machine", async () => {
  const f = fixture(16),
    before = structuredClone(f.snapshot),
    double = cpuDouble();
  let complete;
  const crypto = {
    subtle: {
      digest(algorithm, bytes) {
        const value = webcrypto.subtle.digest(algorithm, bytes);
        return new Promise((resolve) => {
          complete = async () => resolve(await value);
        });
      },
    },
  };
  const pending = prepare(f, double, { crypto });
  assert.deepEqual(double.events, []);
  f.snapshot.slots[0].bytes.fill(0);
  f.snapshot.slots[15].name = "changed";
  f.snapshot.bootstrap.bytes.fill(0);
  f.deployment.twoMibProfiles.length = 0;
  await complete();
  const runtime = await pending;
  assert.deepEqual(runtime.captureCheckpoint(), before);
  f.snapshot.slots[15].bytes.fill(0);
  assert.deepEqual(runtime.captureCheckpoint(), before);
  runtime.dispose();
});

test("historical inputs are captured before synchronous CPU callbacks", async () => {
  const snapshot = legacy(),
    before = structuredClone(snapshot);
  const double = cpuDouble({
    onInstall() {
      snapshot.drives.A.bytes.fill(0);
      snapshot.bootstrap.bytes.fill(0);
      snapshot.drives.A.name = "changed";
    },
  });
  const runtime = await prepare({ snapshot }, double);
  assert.deepEqual(runtime.captureCheckpoint(), before);
  runtime.dispose();
});

for (const writable of [null, 0, 1, "false", {}, []])
  test(`rejects writable type ${JSON.stringify(writable)} before constructing a CPU`, async () => {
    const double = cpuDouble();
    await assert.rejects(
      prepare({ snapshot: legacy() }, double, { writable }),
      /boolean/,
    );
    assert.deepEqual(double.events, []);
  });

for (const failure of ["construct", "install:0", "install:15", "reset"])
  test(`failure at ${failure} never publishes a CPU and frees a created CPU exactly once`, async () => {
    const f = fixture(16),
      before = structuredClone(f.snapshot),
      double = cpuDouble({ fail: failure });
    await assert.rejects(prepare(f, double), new RegExp(failure));
    assert.deepEqual(f.snapshot, before);
    assert.equal(double.instances.length, failure === "construct" ? 0 : 1);
    if (double.instances.length) assert.equal(double.instances[0].freed, 1);
  });

test("unsupported or unavailable profiles reject before CPU allocation and leave originals intact", async () => {
  for (const mode of [
    "unknown-schema",
    "wrong-profile",
    "missing",
    "bootstrap",
    "malformed",
    "shared",
  ]) {
    const f = fixture(2),
      double = cpuDouble();
    if (mode === "unknown-schema") f.snapshot.schema = "future";
    if (mode === "wrong-profile")
      f.snapshot.bootstrap.profile = "triptych-cpu-v0.1-2m-n03";
    if (mode === "missing") delete f.deployment.twoMibProfiles;
    if (mode === "bootstrap") f.snapshot.bootstrap.bytes[0] ^= 1;
    if (mode === "malformed")
      f.deployment.twoMibProfiles[0].configuredCount = 3;
    if (mode === "shared")
      f.snapshot.slots[0].bytes = new Uint8Array(
        new SharedArrayBuffer(2097152),
      );
    const before = structuredClone(f.snapshot);
    await assert.rejects(prepare(f, double), (error) => {
      if (mode === "missing") assert.equal(error.code, "PROFILE_UNAVAILABLE");
      if (mode === "bootstrap")
        assert.equal(error.code, "SAVED_BOOTSTRAP_MISMATCH");
      return true;
    });
    assert.deepEqual(double.events, []);
    assert.deepEqual(f.snapshot, before);
  }
  const snapshot = legacy();
  snapshot.bootstrap.profile = "future";
  await assert.rejects(prepare({ snapshot }), /unsupported resident profile/);
});

test("constructor argument errors and cleanup exceptions have explicit failure behavior", async () => {
  await assert.rejects(
    prepareSavedMachineRuntime({ snapshot: legacy(), TriptychCpu: null }),
    /constructor/,
  );
  const double = cpuDouble({ fail: "reset" });
  double.TriptychCpu.prototype.free = function () {
    this.freed++;
    throw Error("cleanup");
  };
  await assert.rejects(prepare({ snapshot: legacy() }, double), (error) => {
    assert(error instanceof AggregateError);
    assert.deepEqual(
      error.errors.map((e) => e.message),
      ["reset", "cleanup"],
    );
    return true;
  });
  assert.equal(double.instances[0].freed, 1);
  const normal = await prepare({ snapshot: legacy() });
  const cpu = normal.cpu;
  cpu.free = () => {
    cpu.freed++;
    throw Error("cleanup");
  };
  assert.throws(() => normal.dispose(), /cleanup/);
  normal.dispose();
  assert.equal(cpu.freed, 1);
  assert.throws(() => normal.captureCheckpoint(), /disposed/);
});

test("bad checkpoint exports fail without substituting live backing or disposing the runtime", async () => {
  const runtime = await prepare({ snapshot: legacy() });
  const cpu = runtime.cpu;
  cpu.export_drive_checkpoint = () => new Uint8Array(511);
  assert.throws(() => runtime.captureCheckpoint(), /checkpoint export/);
  assert.equal(runtime.cpu, cpu);
  runtime.dispose();
});
