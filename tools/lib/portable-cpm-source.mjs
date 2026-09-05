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
const PROFILE =
  "CCPBAS EQU $E400\nBDOSBAS EQU $EC00\nBIOSBAS EQU $FA00\nBIOSEND EQU $FE00\n";

async function verifiedSource(repositoryRoot, id) {
  assert.ok(id === "ccp" || id === "bdos", "Portable CP/M component id");
  const lock = validateComponentLock(
    JSON.parse(
      await readFile(join(repositoryRoot, "distribution/components.lock.json")),
    ),
    { recipes: new Set(["verified-release", "atom-binary", "atom-cpm22"]) },
  );
  const component = lock.components.find((entry) => entry.id === id);
  assert.ok(component, `missing Portable CP/M ${id} component`);
  const released = await readVerifiedRelease(repositoryRoot, component);
  validateDistributionManifest(
    component,
    released.manifest,
    lock.atom.revision,
  );
  const metadata = released.manifest.components.find(
    (entry) => entry.id === id,
  );
  const source = await readFile(
    join(repositoryRoot, "third_party/portable-cpm", metadata.source),
  );
  assert.equal(
    hash(source),
    metadata.sourceSha256,
    `${id} source snapshot digest`,
  );
  const prepared = PROFILE + source.toString("utf8");
  assert.equal(
    hash(prepared),
    metadata.preparedSourceSha256,
    `${id} profiled source digest`,
  );
  return { prepared, released, component };
}

/** Prepare the pinned source with its released Triptych profile for guest proofs. */
export async function preparePortableCpmSource(repositoryRoot, id) {
  return (await verifiedSource(repositoryRoot, id)).prepared;
}

/** Assemble pinned upstream source privately and prove identity with its release. */
export async function assemblePortableCpmSource(repositoryRoot, id) {
  const { prepared, released, component } = await verifiedSource(
    repositoryRoot,
    id,
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

export async function portableCpmBinary(repositoryRoot, id) {
  return (await assemblePortableCpmSource(repositoryRoot, id)).bytes;
}
