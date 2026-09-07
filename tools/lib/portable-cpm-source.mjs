import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleAtomFile } from "./assemble-atom.mjs";
import { validateComponentLock } from "./component-lock.mjs";
import { validateDistributionManifest } from "./distribution-manifests.mjs";
import { readVerifiedRelease } from "./verified-release.mjs";
import { twoMibResidentProfile } from "./cpm-two-mib-profile.mjs";

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

// Only named, reviewed release inputs are admissible. No checkout discovery,
// network acquisition, or geometry-based substitution occurs in this consumer.
for (let count = 1; count <= 16; count++) {
  const profile = twoMibResidentProfile(count);
  const suffix = String(count).padStart(2, "0");
  PROFILES[profile.id] = {
    lock: `distribution/residents-2m/n${suffix}.lock.json`,
    snapshots: "third_party/portable-cpm/2m/v0.1.4",
    preamble:
      Object.entries({
        CCPBAS: profile.ccp,
        BDOSBAS: profile.bdos,
        BIOSBAS: profile.bios,
        BIOSEND: profile.end,
      })
        .map(
          ([name, value]) => `${name} EQU $${value.toString(16).toUpperCase()}`,
        )
        .join("\n") + "\n",
    twoMib: true,
  };
}

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
  if (profile.twoMib) {
    assert.deepEqual(
      lock.disk,
      { bytes: 2097152, recordBytes: 128, systemRecords: 128 },
      "two-MiB resident disk",
    );
    assert.deepEqual(
      lock.components.map(({ id }) => id),
      ["ccp", "bdos"],
      "two-MiB resident components",
    );
    assert.equal(
      lock.components[0].artifact.manifest,
      lock.components[1].artifact.manifest,
      "one OS profile manifest",
    );
    for (const entry of lock.components) {
      assert.equal(
        entry.source.revision,
        "d28fc52774c967d1422b3b814d51c069247504c1",
        "two-MiB released source revision",
      );
    }
  }
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
