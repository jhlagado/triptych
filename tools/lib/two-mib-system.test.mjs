import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { buildTwoMibSystem, validateTwoMibSystem } from "./two-mib-system.mjs";
import { readVerifiedRelease } from "./verified-release.mjs";

const root = resolve(import.meta.dirname, "../..");
const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const builds = new Map();
async function build(count) {
  if (!builds.has(count))
    builds.set(
      count,
      await buildTwoMibSystem(root, count, { allowDirty: true }),
    );
  return builds.get(count);
}

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), "triptych-system-fixture-"));
  try {
    for (const path of [
      "distribution/residents-2m",
      "third_party/portable-cpm/2m",
      "system/cpm/bios-2m.asm",
      "roms/cpu/bootstrap-2m.asm",
      "tools/lib/cpm-two-mib-profile.mjs",
      "package.json",
      "package-lock.json",
    ]) {
      const destination = join(directory, path);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(root, path), destination, { recursive: true });
    }
    await exec("git", ["init", "--quiet"], { cwd: directory });
    await exec(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "--quiet",
        "--allow-empty",
        "-m",
        "Fixture",
      ],
      { cwd: directory },
    );
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("all sixteen named release tuples reproduce with exact budgets and pair identities", async () => {
  for (let count = 1; count <= 16; count++) {
    const result = await build(count);
    const { descriptor, evidence, system, bootstrap } = result;
    const suffix = String(count).padStart(2, "0");
    const allocationBase = 65536 - 256 * Math.ceil(count / 2);
    assert.equal(descriptor.schema, "triptych-two-mib-system-v1");
    assert.equal(descriptor.residentProfile, `triptych-cpu-v0.1-2m-n${suffix}`);
    assert.equal(descriptor.configuredCount, count);
    assert.equal(descriptor.layout.allocationBase, allocationBase);
    assert.equal(descriptor.layout.ccp, allocationBase - 6656);
    assert.equal(descriptor.layout.bdos, allocationBase - 4608);
    assert.equal(descriptor.layout.bios, allocationBase - 1024);
    assert.equal(
      descriptor.system.asset,
      `system-triptych-cpm-2m-n${suffix}-v1.bin`,
    );
    assert.equal(
      descriptor.bootstrap.asset,
      `bootstrap-triptych-cpm-2m-n${suffix}-v1.bin`,
    );
    assert.equal(system.length, 16384);
    assert.equal(bootstrap.length, 256);
    assert.equal(hash(system), descriptor.system.sha256);
    assert.ok(system.subarray(6656).every((byte) => byte === 0));
    assert.equal(descriptor.bios.commonEnd - descriptor.layout.bios, 723);
    assert.equal(
      evidence.machine.bios.labels.DPHEND -
        evidence.machine.bios.labels.DPHEADS,
      count * 16,
    );
    assert.equal(
      evidence.residents.ccp.labels.STKGUEND -
        evidence.residents.ccp.labels.STKGUARD,
      16,
    );
    assert.equal(
      evidence.residents.bdos.labels.STKTOP -
        evidence.residents.bdos.labels.STKBASE,
      64,
    );
    assert.equal(descriptor.residents.version, "0.1.4");
    assert.equal(
      descriptor.residents.revision,
      "d28fc52774c967d1422b3b814d51c069247504c1",
    );
    assert.equal(
      descriptor.atom.packageIntegrity,
      JSON.parse(
        Buffer.from(evidence.residents.ccp.evidence.release.manifestBytes),
      ).atom.packageIntegrity,
    );
    assert.equal(validateTwoMibSystem(result, count), result);
    if (count % 2 === 0) {
      const odd = await build(count - 1);
      assert.deepEqual(odd.system.subarray(0, 5632), system.subarray(0, 5632));
      assert.deepEqual(odd.bootstrap, bootstrap);
      assert.notDeepEqual(
        odd.system.subarray(5632, 6656),
        system.subarray(5632, 6656),
      );
      assert.notEqual(
        odd.descriptor.residents.lockSha256,
        descriptor.residents.lockSha256,
      );
    }
  }
});

test("invalid count is rejected before filesystem or assembly work", async () => {
  for (const value of [undefined, null, "2", 0, 17, -1, 1.5, NaN, Infinity]) {
    await assert.rejects(
      buildTwoMibSystem("/does-not-exist", value),
      /integer from 1 to 16/,
    );
  }
});

test("release evidence is opt-in, exact, and detached from parsed data and later reads", async () => {
  const lock = JSON.parse(
    await readFile(join(root, "distribution/residents-2m/n03.lock.json")),
  );
  const component = lock.components[0];
  const historical = await readVerifiedRelease(root, component);
  assert.deepEqual(Object.keys(historical), ["bytes", "manifest"]);
  const captured = await readVerifiedRelease(root, component, {
    captureEvidence: true,
  });
  const manifestBytes = Uint8Array.from(
    await readFile(join(root, component.artifact.manifest)),
  );
  const provenanceBytes = Uint8Array.from(
    await readFile(join(root, component.artifact.provenance)),
  );
  assert.deepEqual(captured.manifestBytes, manifestBytes);
  assert.deepEqual(captured.provenanceBytes, provenanceBytes);
  captured.manifestBytes.fill(0);
  captured.provenanceBytes.fill(0);
  captured.bytes.fill(0);
  assert.deepEqual(captured.manifest, historical.manifest);
  const again = await readVerifiedRelease(root, component, {
    captureEvidence: true,
  });
  assert.deepEqual(again.manifestBytes, manifestBytes);
  assert.deepEqual(again.provenanceBytes, provenanceBytes);
  assert.deepEqual(again.bytes, historical.bytes);
});

test("descriptor is closed and count, layout, paths and release fields cannot substitute", async () => {
  const original = await build(3);
  const before = hash(original.system);
  for (const change of [
    (d) => {
      d.extra = true;
    },
    (d) => {
      d.configuredCount = 4;
    },
    (d) => {
      d.residentProfile = "triptych-cpu-v0.1-2m-n04";
    },
    (d) => {
      d.layout.dphEnd += 16;
    },
    (d) => {
      d.system.asset = "system-triptych-cpm-2m-n04-v1.bin";
    },
    (d) => {
      d.bootstrap.asset = "bootstrap-triptych-cpm-2m-n04-v1.bin";
    },
    (d) => {
      d.residents.lock = "distribution/residents-2m/n04.lock.json";
    },
    (d) => {
      d.residents.manifest = d.residents.manifest.replace("n03", "n04");
    },
    (d) => {
      d.residents.ccp.offset = 128;
    },
    (d) => {
      d.residents.bdos.origin += 256;
    },
    (d) => {
      d.bios.preparedSourceSha256 = "0".repeat(64);
    },
    (d) => {
      d.machine.generatorSha256 = "0".repeat(64);
    },
  ]) {
    const candidate = {
      ...original,
      descriptor: structuredClone(original.descriptor),
    };
    change(candidate.descriptor);
    assert.throws(
      () => validateTwoMibSystem(candidate, 3),
      /closed two-MiB descriptor/,
    );
  }
  assert.throws(
    () => validateTwoMibSystem(original, 4),
    /named resident lock profile/,
  );
  assert.equal(hash(original.system), before);
});

test("neighbor BIOS and rehashed count/table corruption fail independently of outer hashes", async () => {
  const original = await build(3);
  const neighbor = await build(4);
  for (const change of [
    (bios) => bios.set(neighbor.evidence.machine.bios.bytes),
    (bios, labels, base) => {
      bios[labels.SELDSK - base + 2] = 4;
    },
    (bios, labels, base) => {
      bios[labels.WRMFLUSH - base + 2] = 4;
    },
    (bios, labels, base) => {
      bios[labels.SELADDR - base + 4] = 4;
    },
    (bios) => {
      bios[768 + 14] ^= 128;
    },
    (bios) => {
      bios[768 + 3 * 16] = 1;
    },
  ]) {
    const candidate = structuredClone(original);
    const bios = candidate.evidence.machine.bios;
    change(bios.bytes, bios.labels, bios.base);
    candidate.system.set(bios.bytes, 5632);
    candidate.evidence.systemSha256 = hash(candidate.system);
    candidate.descriptor.system.sha256 = hash(candidate.system);
    candidate.descriptor.bios.sha256 = hash(bios.bytes);
    assert.throws(
      () => validateTwoMibSystem(candidate, 3),
      /DPH|count operand/,
    );
  }
});

test("bootstrap pair substitution, nonzero system tail and output aliasing are rejected", async () => {
  const original = await build(3);
  const different = await build(5);
  const candidate = structuredClone(original);
  candidate.evidence.machine.bootstrap.bytes.set(different.bootstrap);
  candidate.bootstrap.set(different.bootstrap);
  candidate.descriptor.bootstrap.sha256 = hash(candidate.bootstrap);
  assert.throws(() => validateTwoMibSystem(candidate, 3), /bootstrap stack/);
  const tail = structuredClone(original);
  tail.system[16383] = 1;
  tail.evidence.systemSha256 = hash(tail.system);
  tail.descriptor.system.sha256 = hash(tail.system);
  assert.throws(() => validateTwoMibSystem(tail, 3), /reserved system tail/);
  const detached = structuredClone(original);
  detached.system[0] ^= 1;
  detached.bootstrap[0] ^= 1;
  assert.equal(detached.evidence.residents.ccp.bytes[0], original.system[0]);
  assert.equal(
    detached.evidence.machine.bootstrap.bytes[0],
    original.bootstrap[0],
  );
  const release = detached.evidence.residents.ccp.evidence.release;
  const parsed = structuredClone(release.manifest);
  release.manifestBytes[0] ^= 1;
  release.provenanceBytes[0] ^= 1;
  assert.deepEqual(release.manifest, parsed);
  assert.equal(hash(original.system), original.descriptor.system.sha256);
});

test("root-bound raw sources are captured, while mismatched generator and named locks fail closed", async () => {
  await fixture(async (directory) => {
    const sourcePath = join(directory, "system/cpm/bios-2m.asm");
    const raw = await readFile(sourcePath);
    await writeFile(
      sourcePath,
      Buffer.concat([raw, Buffer.from("\n; Captured fixture source.\n")]),
    );
    const changed = await buildTwoMibSystem(directory, 3, { allowDirty: true });
    const original = await build(3);
    assert.deepEqual(changed.system, original.system);
    assert.notEqual(
      changed.descriptor.bios.sourceSha256,
      original.descriptor.bios.sourceSha256,
    );
    assert.notEqual(
      changed.descriptor.bios.preparedSourceSha256,
      original.descriptor.bios.preparedSourceSha256,
    );
    await writeFile(sourcePath, "changed after capture");
    validateTwoMibSystem(changed, 3);
    await assert.rejects(
      buildTwoMibSystem(directory, 3),
      /clean Triptych checkout/,
    );
    await writeFile(sourcePath, raw);
    const lockPath = join(directory, "distribution/residents-2m/n03.lock.json");
    const lockBytes = await readFile(lockPath);
    await cp(
      join(directory, "distribution/residents-2m/n04.lock.json"),
      lockPath,
    );
    await assert.rejects(
      buildTwoMibSystem(directory, 3, { allowDirty: true }),
      /named resident lock profile/,
    );
    const lock = JSON.parse(lockBytes);
    lock.components[0].artifact.manifest =
      lock.components[0].artifact.manifest.replace("n03", "n04");
    await writeFile(lockPath, JSON.stringify(lock));
    await assert.rejects(
      buildTwoMibSystem(directory, 3, { allowDirty: true }),
      /named resident manifest/,
    );
    await writeFile(lockPath, lockBytes);
    const generatorPath = join(directory, "tools/lib/cpm-two-mib-profile.mjs");
    await writeFile(
      generatorPath,
      Buffer.concat([
        await readFile(generatorPath),
        Buffer.from("\n// Different generator.\n"),
      ]),
    );
    await assert.rejects(
      buildTwoMibSystem(directory, 3, { allowDirty: true }),
      /root generator differs/,
    );
  });
});

test("fresh verification binds raw/prepared OS and machine evidence and actual ATOM seed", async () => {
  const original = await build(3);
  for (const mutate of [
    (e) => {
      e.residents.ccp.evidence.sourceBytes[0] ^= 1;
    },
    (e) => {
      e.residents.bdos.evidence.preparedSource += "\n";
    },
    (e) => {
      e.residents.ccp.evidence.release.provenanceBytes[0] ^= 1;
    },
    (e) => {
      e.machine.rawSources.bios[0] ^= 1;
    },
    (e) => {
      e.machine.bootstrapSource += "\n";
    },
    (e) => {
      e.atomSeedBytes[0] ^= 1;
    },
    (e) => {
      e.packageBytes[0] ^= 1;
    },
  ]) {
    const candidate = structuredClone(original);
    mutate(candidate.evidence);
    assert.throws(() => validateTwoMibSystem(candidate, 3));
  }
});
