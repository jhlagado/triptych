import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadNativeAtomCore } from "atom-z80";
import {
  twoMibResidentProfile,
  prepareTwoMibSources,
  prepareTwoMibSourcesFromBodies,
  assemblePreparedTwoMibProfile,
} from "./cpm-two-mib-profile.mjs";
import { assemblePortableCpmSourceWithEvidence } from "./portable-cpm-source.mjs";
import { validateComponentLock } from "./component-lock.mjs";
import { validateDistributionManifest } from "./distribution-manifests.mjs";

const exec = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const text = (bytes) => Buffer.from(bytes).toString("utf8");
const json = (bytes) => JSON.parse(text(bytes));
const GENERATOR = "tools/lib/cpm-two-mib-profile.mjs";
// Capture beside the imported implementation at module initialization, not a
// later reread that could describe a different generator after source edits.
const RUNNING_GENERATOR_BYTES = Uint8Array.from(
  await readFile(new URL("./cpm-two-mib-profile.mjs", import.meta.url)),
);
const OS_ROOT = "third_party/portable-cpm/2m/v0.1.4";
const OS_REVISION = "d28fc52774c967d1422b3b814d51c069247504c1";
const OS_REPOSITORY = "https://github.com/jhlagado/portable-cpm.git";
const SHA256 = /^[0-9a-f]{64}$/;

function validateGenerator(bytes) {
  assert.deepEqual(
    Uint8Array.from(bytes),
    RUNNING_GENERATOR_BYTES,
    "root generator differs from running implementation",
  );
}

function paths(profile) {
  const suffix = `n${String(profile.count).padStart(2, "0")}`;
  return {
    lock: `distribution/residents-2m/${suffix}.lock.json`,
    manifest: `${OS_ROOT}/profiles/${profile.id}/manifest.json`,
    system: `system-triptych-cpm-2m-${suffix}-v1.bin`,
    bootstrap: `bootstrap-triptych-cpm-2m-${suffix}-v1.bin`,
  };
}

function lockFor(bytes, profile) {
  const lock = validateComponentLock(json(bytes), {
    recipes: new Set(["verified-release"]),
  });
  assert.equal(lock.targetProfile, profile.id, "named resident lock profile");
  assert.deepEqual(
    lock.disk,
    {
      bytes: 2097152,
      recordBytes: 128,
      systemRecords: 128,
    },
    "two-MiB locked geometry",
  );
  assert.deepEqual(
    lock.components.map(({ id }) => id),
    ["ccp", "bdos"],
  );
  for (const component of lock.components) {
    assert.equal(component.source.repository, OS_REPOSITORY);
    assert.equal(component.source.revision, OS_REVISION);
    const prefix = `${OS_ROOT}/profiles/${profile.id}`;
    assert.equal(
      component.artifact.path,
      `${prefix}/${component.id}.bin`,
      "named resident artifact",
    );
    assert.equal(
      component.artifact.manifest,
      paths(profile).manifest,
      "named resident manifest",
    );
    assert.equal(
      component.artifact.provenance,
      `${prefix}/${component.id}.provenance.json`,
      "named resident provenance",
    );
  }
  return lock;
}

function atomFor(lock, evidence) {
  assert.equal(lock.atom.repository, "https://github.com/jhlagado/atom.git");
  const spec = `git+${lock.atom.repository}#${lock.atom.revision}`;
  assert.equal(
    json(evidence.packageBytes).devDependencies["atom-z80"],
    spec,
    "package ATOM spec",
  );
  const npmLock = json(evidence.packageLockBytes);
  assert.equal(
    npmLock.packages[""].devDependencies["atom-z80"],
    spec,
    "npm root ATOM spec",
  );
  const installed = npmLock.packages["node_modules/atom-z80"];
  assert.equal(installed.resolved, spec, "installed ATOM lock identity");
  assert.equal(typeof installed.integrity, "string");
  assert.match(
    installed.integrity,
    /^sha512-[A-Za-z0-9+/]+={0,2}$/,
    "ATOM package integrity",
  );
  assert.equal(
    evidence.atomSeedBytes.length,
    lock.atom.seed.bytes,
    "ATOM seed byte count",
  );
  assert.equal(
    hash(evidence.atomSeedBytes),
    lock.atom.seed.sha256,
    "ATOM seed digest",
  );
  return {
    ...structuredClone(lock.atom),
    packageIntegrity: installed.integrity,
  };
}

function residentFor(id, evidence, lock, profile, atom) {
  const component = lock.components.find((entry) => entry.id === id);
  const resident = evidence.residents[id];
  assert.deepEqual(
    resident.evidence.lockBytes,
    evidence.lockBytes,
    "one captured resident lock",
  );
  const released = resident.evidence.release;
  const manifest = json(released.manifestBytes);
  assert.deepEqual(released.manifest, manifest, "captured release manifest");
  validateDistributionManifest(component, manifest, atom.revision, profile.id);
  assert.equal(
    manifest.atom.packageIntegrity,
    atom.packageIntegrity,
    "release ATOM package integrity",
  );
  const provenance = json(released.provenanceBytes);
  assert.deepEqual(
    Object.keys(provenance).sort(),
    [
      "schema",
      "repository",
      "revision",
      "bytes",
      "sha256",
      "manifestSha256",
      "origin",
    ].sort(),
  );
  assert.equal(provenance.schema, "triptych-release-provenance-v1");
  assert.equal(provenance.repository, component.source.repository);
  assert.equal(provenance.revision, component.source.revision);
  assert.equal(provenance.bytes, component.artifact.bytes);
  assert.equal(provenance.sha256, component.artifact.sha256);
  assert.equal(provenance.manifestSha256, hash(released.manifestBytes));
  assert.deepEqual(Object.keys(provenance.origin).sort(), ["kind", "url"]);
  assert.ok(["release-asset", "ci-artifact"].includes(provenance.origin.kind));
  const origin = new URL(provenance.origin.url);
  assert.ok(
    origin.protocol === "https:" && !origin.username && !origin.password,
  );
  const metadata = manifest.components.find((entry) => entry.id === id);
  assert.equal(
    hash(resident.evidence.sourceBytes),
    metadata.sourceSha256,
    `${id} raw source`,
  );
  assert.equal(
    hash(resident.evidence.preparedSource),
    metadata.preparedSourceSha256,
    `${id} prepared source`,
  );
  assert.equal(
    resident.base,
    component.target.origin,
    `${id} assembled origin`,
  );
  assert.equal(
    resident.bytes.length,
    component.artifact.bytes,
    `${id} assembled extent`,
  );
  assert.equal(
    hash(resident.bytes),
    component.artifact.sha256,
    `${id} assembled release digest`,
  );
  assert.deepEqual(
    resident.bytes,
    released.bytes,
    `${id} assembled release bytes`,
  );
  return {
    source: `${OS_ROOT}/${component.source.path}`,
    sourceSha256: metadata.sourceSha256,
    preparedSourceSha256: metadata.preparedSourceSha256,
    sha256: component.artifact.sha256,
    offset: component.install.firstRecord * 128,
    origin: component.target.origin,
    bytes: component.artifact.bytes,
  };
}

function layoutFor(profile) {
  return {
    ccp: profile.ccp,
    bdos: profile.bdos,
    bios: profile.bios,
    allocationBase: profile.allocationBase,
    allocationBytes: profile.allocationBytes,
    commonLimit: profile.commonLimit,
    dphBase: profile.dphBase,
    dphEnd: profile.dphBase + profile.count * 16,
  };
}

const word = (bytes, offset) => bytes[offset] | (bytes[offset + 1] << 8);

function machineLayout(machine, profile) {
  const { bios, bootstrap } = machine;
  const labels = bios.labels;
  assert.equal(bios.base, profile.bios, "BIOS origin");
  assert.equal(bios.bytes.length, 1024, "BIOS length");
  assert.equal(bootstrap.base, 0, "bootstrap origin");
  assert.equal(bootstrap.bytes.length, 256, "bootstrap length");
  assert.equal(labels.DPHEADS, profile.dphBase, "DPH origin");
  assert.equal(
    labels.DPHEND,
    profile.dphBase + profile.count * 16,
    "DPH count",
  );
  assert.ok(
    Number.isInteger(labels.COMMONND) &&
      labels.COMMONND > profile.bios &&
      labels.COMMONND <= profile.commonLimit,
    "common BIOS budget",
  );
  assert.equal(labels.BOOTSP, labels.COMMONND, "common end follows boot stack");
  assert.equal(labels.CHKSVEC + 32, labels.BOOTSP, "boot stack extent");
  assert.equal(labels.DIRBUF + 128, labels.CHKSVEC, "directory buffer extent");
  assert.equal(labels.DPBLOCK + 15, labels.DIRBUF, "DPB extent");
  assert.ok(
    labels.DPBLOCK >= profile.bios && labels.DIRBUF < profile.commonLimit,
  );
  const offset = (label) => {
    const value = labels[label] - bios.base;
    assert.ok(
      Number.isInteger(value) && value >= 0 && value < 768,
      `${label} inside common BIOS`,
    );
    return value;
  };
  assert.deepEqual(
    Array.from(bios.bytes.subarray(offset("DPBLOCK"), offset("DIRBUF"))),
    [128, 0, 4, 15, 0, 247, 3, 255, 3, 255, 255, 0, 0, 1, 0],
    "two-MiB DPB bytes",
  );
  assert.ok(
    bios.bytes
      .subarray(labels.COMMONND - bios.base, 768)
      .every((byte) => byte === 0),
    "common BIOS padding",
  );
  for (let drive = 0; drive < profile.count; drive++) {
    const start = 768 + drive * 16;
    assert.equal(labels[`DPH${drive}`], bios.base + start, "DPH label");
    const words = Array.from({ length: 8 }, (_, index) =>
      word(bios.bytes, start + index * 2),
    );
    assert.deepEqual(
      words,
      [
        0,
        0,
        0,
        0,
        labels.DIRBUF,
        labels.DPBLOCK,
        labels.CHKSVEC,
        profile.allocationBase + drive * 128,
      ],
      "configured DPH and ALV bytes",
    );
  }
  assert.ok(
    bios.bytes.subarray(768 + profile.count * 16).every((byte) => byte === 0),
    "unused DPH table padding",
  );
  const seldsk = offset("SELDSK");
  assert.equal(bios.bytes[27], 0xc3);
  assert.equal(word(bios.bytes, 28), labels.SELDSK, "SELDSK public vector");
  assert.deepEqual(
    Array.from(bios.bytes.subarray(seldsk, seldsk + 7)),
    [0x79, 0xfe, profile.count, 0x21, 0, 0, 0xd0],
    "SELDSK configured count operand",
  );
  assert.deepEqual(
    Array.from(bios.bytes.subarray(offset("WRMFLUSH"), offset("WRMFLUSH") + 3)),
    [0x79, 0xfe, profile.count],
    "warm flush configured count operand",
  );
  assert.deepEqual(
    Array.from(
      bios.bytes.subarray(offset("SELADDR") + 3, offset("SELADDR") + 5),
    ),
    [0xfe, profile.count],
    "record address configured count operand",
  );
  assert.equal(bootstrap.bytes[0], 0xf3);
  assert.equal(bootstrap.bytes[1], 0x31);
  assert.equal(
    word(bootstrap.bytes, 2),
    profile.bootstrapStub,
    "bootstrap stack",
  );
  assert.equal(
    word(bootstrap.bytes, 16),
    profile.bootstrapRecord,
    "bootstrap record scratch",
  );
  assert.equal(bootstrap.bytes[19], profile.coldRecords, "cold record count");
  assert.equal(
    word(bootstrap.bytes, 21),
    profile.bootstrapRemaining,
    "bootstrap count scratch",
  );
  assert.equal(
    word(bootstrap.bytes, 24),
    profile.ccp,
    "bootstrap resident origin",
  );
  const stub = bootstrap.labels.DISSTUB;
  assert.ok(Number.isInteger(stub) && stub > 26 && stub + 7 <= 256);
  assert.deepEqual(
    Array.from(bootstrap.bytes.subarray(stub, stub + 5)),
    [0x3e, 0xa5, 0xd3, 0x20, 0xc3],
    "overlay exit stub",
  );
  assert.equal(
    word(bootstrap.bytes, stub + 5),
    profile.bios,
    "bootstrap BIOS entry",
  );
  assert.equal(bootstrap.labels.STUBEND, stub + 7);
  assert.ok(
    bootstrap.bytes.subarray(stub + 7).every((byte) => byte === 0),
    "bootstrap padding",
  );
}

function describe(evidence, profile) {
  validateGenerator(evidence.generatorBytes);
  const names = paths(profile);
  const lock = lockFor(evidence.lockBytes, profile);
  const atom = atomFor(lock, evidence);
  const ccp = residentFor("ccp", evidence, lock, profile, atom);
  const bdos = residentFor("bdos", evidence, lock, profile, atom);
  assert.deepEqual(
    evidence.residents.ccp.evidence.release.manifestBytes,
    evidence.residents.bdos.evidence.release.manifestBytes,
    "one OS profile manifest",
  );
  const machine = evidence.machine;
  const prepared = prepareTwoMibSourcesFromBodies(
    profile.count,
    machine.rawSources,
    { repositoryRoot: machine.repositoryRoot },
  );
  assert.equal(
    machine.biosSource,
    prepared.biosSource,
    "captured BIOS preparation",
  );
  assert.equal(
    machine.bootstrapSource,
    prepared.bootstrapSource,
    "captured bootstrap preparation",
  );
  assert.deepEqual(
    machine.sourceProvenance,
    prepared.sourceProvenance,
    "captured source provenance",
  );
  machineLayout(machine, profile);
  assert.match(evidence.revision, /^[0-9a-f]{40}$/);
  assert.equal(typeof evidence.dirty, "boolean");
  const bios = machine.bios;
  const source = (kind) => {
    const path =
      kind === "bios" ? "system/cpm/bios-2m.asm" : "roms/cpu/bootstrap-2m.asm";
    assert.equal(
      machine.sourceProvenance[kind].path,
      join(machine.repositoryRoot, path),
      "root-bound machine source path",
    );
    return {
      source: path,
      sourceSha256: hash(machine.rawSources[kind]),
      preparedSourceSha256: hash(
        kind === "bios" ? machine.biosSource : machine.bootstrapSource,
      ),
    };
  };
  return {
    schema: "triptych-two-mib-system-v1",
    id: profile.format,
    residentProfile: profile.id,
    configuredCount: profile.count,
    imageBytes: 2097152,
    systemBytes: 16384,
    layout: layoutFor(profile),
    system: {
      asset: names.system,
      bytes: 16384,
      sha256: evidence.systemSha256,
    },
    bootstrap: {
      asset: names.bootstrap,
      bytes: 256,
      sha256: hash(machine.bootstrap.bytes),
      ...source("bootstrap"),
    },
    residents: {
      lock: names.lock,
      lockSha256: hash(evidence.lockBytes),
      manifest: names.manifest,
      manifestSha256: hash(
        evidence.residents.ccp.evidence.release.manifestBytes,
      ),
      repository: OS_REPOSITORY,
      version: "0.1.4",
      revision: OS_REVISION,
      ccp,
      bdos,
    },
    bios: {
      ...source("bios"),
      sha256: hash(bios.bytes),
      commonEnd: bios.labels.COMMONND,
      directoryBuffer: bios.labels.DIRBUF,
      dpb: bios.labels.DPBLOCK,
      checksumVector: bios.labels.CHKSVEC,
    },
    atom,
    machine: {
      revision: evidence.revision,
      dirty: evidence.dirty,
      generator: GENERATOR,
      generatorSha256: hash(evidence.generatorBytes),
    },
  };
}

/** Verify a fresh build against captured evidence and an independently selected
 * count. Synchronous, read-only, and not an ownership transfer or a signature.
 * Never apply this release-byte verifier to a saved guest-modified disk.
 */
export function validateTwoMibSystem(result, configuredCount) {
  const profile = twoMibResidentProfile(configuredCount);
  assert.deepEqual(
    result.descriptor,
    describe(result.evidence, profile),
    "closed two-MiB descriptor",
  );
  const { system, bootstrap, evidence } = result;
  assert.ok(
    system instanceof Uint8Array && system.buffer instanceof ArrayBuffer,
  );
  assert.ok(
    bootstrap instanceof Uint8Array && bootstrap.buffer instanceof ArrayBuffer,
  );
  assert.equal(system.length, 16384, "system area length");
  assert.equal(bootstrap.length, 256, "bootstrap length");
  assert.match(evidence.systemSha256, SHA256);
  assert.equal(hash(system), evidence.systemSha256, "system digest");
  assert.deepEqual(
    system.subarray(0, 2048),
    evidence.residents.ccp.bytes,
    "installed CCP",
  );
  assert.deepEqual(
    system.subarray(2048, 5632),
    evidence.residents.bdos.bytes,
    "installed BDOS",
  );
  assert.deepEqual(
    system.subarray(5632, 6656),
    evidence.machine.bios.bytes,
    "installed BIOS",
  );
  assert.ok(
    system.subarray(6656).every((byte) => byte === 0),
    "reserved system tail",
  );
  assert.deepEqual(
    bootstrap,
    evidence.machine.bootstrap.bytes,
    "installed bootstrap",
  );
  return result;
}

/** Build only fresh private artifacts from the named retained release and ATOM.
 * No checkout discovery, acquisition, saved-media read, installation, or publish.
 * Like the existing release verifier, assumes a trusted local filesystem without
 * concurrent hostile changes. Captured sources are hashed and assembled once.
 */
export async function buildTwoMibSystem(
  repositoryRoot,
  configuredCount,
  { allowDirty = false } = {},
) {
  const profile = twoMibResidentProfile(configuredCount);
  const root = await realpath(repositoryRoot);
  const names = paths(profile);
  const [
    lockBytes,
    packageBytes,
    packageLockBytes,
    generatorBytes,
    prepared,
    revisionResult,
    statusResult,
  ] = await Promise.all([
    readFile(join(root, names.lock)),
    readFile(join(root, "package.json")),
    readFile(join(root, "package-lock.json")),
    readFile(join(root, GENERATOR)),
    prepareTwoMibSources(configuredCount, { repositoryRoot: root }),
    exec("git", ["rev-parse", "HEAD"], { cwd: root }),
    exec("git", ["status", "--porcelain"], { cwd: root }),
  ]);
  validateGenerator(generatorBytes);
  const dirty = statusResult.stdout.length !== 0;
  assert.ok(
    allowDirty || !dirty,
    "release system requires a clean Triptych checkout",
  );
  const lock = lockFor(lockBytes, profile);
  const core = await loadNativeAtomCore();
  const atomSeedBytes = await readFile(core.artifactPath);
  const evidence = {
    lockBytes: Uint8Array.from(lockBytes),
    packageBytes: Uint8Array.from(packageBytes),
    packageLockBytes: Uint8Array.from(packageLockBytes),
    generatorBytes: Uint8Array.from(generatorBytes),
    atomSeedBytes: Uint8Array.from(atomSeedBytes),
    revision: revisionResult.stdout.trim(),
    dirty,
  };
  atomFor(lock, evidence);
  // At most two assemblies are active. Each consumer verifies exact source and
  // release identity; all returned proof arrays belong to this build.
  const [ccp, bdos] = await Promise.all([
    assemblePortableCpmSourceWithEvidence(root, "ccp", profile.id),
    assemblePortableCpmSourceWithEvidence(root, "bdos", profile.id),
  ]);
  const machine = await assemblePreparedTwoMibProfile(prepared);
  evidence.residents = { ccp, bdos };
  evidence.machine = machine;
  const system = new Uint8Array(16384);
  system.set(ccp.bytes, 0);
  system.set(bdos.bytes, 2048);
  system.set(machine.bios.bytes, 5632);
  evidence.systemSha256 = hash(system);
  const result = {
    system,
    bootstrap: Uint8Array.from(machine.bootstrap.bytes),
    descriptor: describe(evidence, profile),
    evidence,
  };
  return validateTwoMibSystem(result, configuredCount);
}
