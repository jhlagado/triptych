import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleAtomFile } from "./assemble-atom.mjs";
import { validateComponentLock } from "./component-lock.mjs";
import { validateDistributionManifest } from "./distribution-manifests.mjs";
import { readVerifiedRelease } from "./verified-release.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const PROFILES = {
  "triptych-cpu-v0.1": {
    lock: "distribution/components.lock.json",
    snapshots: "third_party/portable-cpm",
    preamble:
      "CCPBAS EQU $E400\nBDOSBAS EQU $EC00\nBIOSBAS EQU $FA00\nBIOSEND EQU $FE00\n",
  },
  "triptych-cpu-v0.1-8m-ab": {
    lock: "distribution/residents-8m-ab.lock.json",
    snapshots: "third_party/portable-cpm/8m-ab",
    preamble:
      "CCPBAS EQU $E300\nBDOSBAS EQU $EB00\nBIOSBAS EQU $F900\nBIOSEND EQU $FD00\n",
  },
};

async function verifiedSource(repositoryRoot, id, targetProfile) {
  assert.ok(
    Object.hasOwn(PROFILES, targetProfile),
    "unsupported resident profile",
  );
  const profile = PROFILES[targetProfile];
  assert.ok(id === "ccp" || id === "bdos", "Portable CP/M component id");
  const lock = validateComponentLock(
    JSON.parse(await readFile(join(repositoryRoot, profile.lock))),
    { recipes: new Set(["verified-release", "atom-binary", "atom-cpm22"]) },
  );
  assert.equal(lock.targetProfile, targetProfile, "resident lock profile");
  const component = lock.components.find((entry) => entry.id === id);
  assert.ok(component, `missing Portable CP/M ${id} component`);
  const released = await readVerifiedRelease(repositoryRoot, component);
  validateDistributionManifest(
    component,
    released.manifest,
    lock.atom.revision,
    targetProfile,
  );
  const metadata = released.manifest.components.find(
    (entry) => entry.id === id,
  );
  const source = await readFile(
    join(repositoryRoot, profile.snapshots, metadata.source),
  );
  assert.equal(
    hash(source),
    metadata.sourceSha256,
    `${id} source snapshot digest`,
  );
  const prepared = profile.preamble + source.toString("utf8");
  assert.equal(
    hash(prepared),
    metadata.preparedSourceSha256,
    `${id} profiled source digest`,
  );
  return { prepared, released, component };
}

/** Prepare the pinned source with its released Triptych profile for guest proofs. */
export async function preparePortableCpmSource(
  repositoryRoot,
  id,
  targetProfile = "triptych-cpu-v0.1",
) {
  return (await verifiedSource(repositoryRoot, id, targetProfile)).prepared;
}

/** Assemble pinned upstream source privately and prove identity with its release. */
export async function assemblePortableCpmSource(
  repositoryRoot,
  id,
  targetProfile = "triptych-cpu-v0.1",
) {
  const { prepared, released, component } = await verifiedSource(
    repositoryRoot,
    id,
    targetProfile,
  );
  const temporary = await mkdtemp(join(tmpdir(), "triptych-portable-cpm-"));
  try {
    const source = join(temporary, `${id}.asm`);
    await writeFile(source, prepared);
    const result = await assembleAtomFile(source);
    assert.equal(result.base, component.target.origin, `${id} origin`);
    assert.deepEqual(
      result.bytes,
      released.bytes,
      `${id} source/release byte identity`,
    );
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function portableCpmBinary(
  repositoryRoot,
  id,
  targetProfile = "triptych-cpu-v0.1",
) {
  return (await assemblePortableCpmSource(repositoryRoot, id, targetProfile))
    .bytes;
}
