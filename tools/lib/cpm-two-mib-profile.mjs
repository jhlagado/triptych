import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { isSharedArrayBuffer, isUint8Array } from "node:util/types";
import { assembleAtomFile } from "./assemble-atom.mjs";

const DEFAULT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const hex = (value) => `$${value.toString(16).toUpperCase()}`;

/** The count selects resident addresses; inserted media do not change them. */
export function twoMibResidentProfile(count) {
  if (!Number.isInteger(count) || count < 1 || count > 16) {
    throw new RangeError(
      "configured drive count must be an integer from 1 to 16",
    );
  }
  const allocationBytes = 256 * Math.ceil(count / 2);
  const allocationBase = 0x10000 - allocationBytes;
  const bios = allocationBase - 1024;
  const bdos = bios - 3584;
  const ccp = bdos - 2048;
  const allocationSlots = Array.from({ length: count }, (_, drive) => {
    const start = allocationBase + drive * 128;
    return Object.freeze({
      drive,
      start,
      end: start + 127,
      guard: start + 127,
    });
  });
  return Object.freeze({
    id: `triptych-cpu-v0.1-2m-n${String(count).padStart(2, "0")}`,
    format: "triptych-cpm-2m-v1",
    count,
    ccp,
    bdos,
    bdosEntry: bdos + 6,
    bios,
    end: allocationBase,
    ccpBytes: 2048,
    bdosBytes: 3584,
    biosBytes: 1024,
    commonLimit: bios + 768,
    dphBase: bios + 768,
    allocationBase,
    allocationBytes,
    allocationSlots: Object.freeze(allocationSlots),
    oddTailBytes: allocationBytes - count * 128,
    comBase: 0x100,
    comEnd: ccp,
    comBytes: ccp - 0x100,
    bootstrapStub: ccp - 256,
    bootstrapRecord: ccp - 272,
    bootstrapRemaining: ccp - 271,
    coldRecords: 52,
    warmRecords: 44,
  });
}

function equates(values) {
  return Object.entries(values)
    .map(([name, value]) => `${name} EQU ${hex(value)}`)
    .join("\n");
}

function sourcePaths(repositoryRoot) {
  return Object.freeze({
    bios: join(repositoryRoot, "system/cpm/bios-2m.asm"),
    bootstrap: join(repositoryRoot, "roms/cpu/bootstrap-2m.asm"),
  });
}

function copyBody(value) {
  if (!isUint8Array(value) || isSharedArrayBuffer(value.buffer))
    throw new TypeError(
      "captured source bodies must be unshared Uint8Array bytes",
    );
  return Buffer.from(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function provenance(path, raw, prepared) {
  return Object.freeze({
    path,
    rawByteLength: raw.byteLength,
    rawSha256: sha256(raw),
    preparedByteLength: Buffer.byteLength(prepared, "utf8"),
    preparedSha256: sha256(Buffer.from(prepared, "utf8")),
  });
}

/** Capture exact bytes from the selected root once; the default remains this
 * module's repository. Later preparation/assembly never reads those paths. */
export async function prepareTwoMibSources(
  count,
  { repositoryRoot = DEFAULT_ROOT } = {},
) {
  twoMibResidentProfile(count);
  repositoryRoot = resolve(repositoryRoot);
  const paths = sourcePaths(repositoryRoot);
  const [bios, bootstrap] = await Promise.all([
    readFile(paths.bios),
    readFile(paths.bootstrap),
  ]);
  return prepareTwoMibSourcesFromBodies(
    count,
    { bios, bootstrap },
    { repositoryRoot },
  );
}

/** Pure flat ATOM generation from owned byte copies; no filesystem reads,
 * source substitution or relocation. Raw hashes cover input bytes, including
 * line endings and invalid UTF-8; text decoding retains Node's prior behavior. */
export function prepareTwoMibSourcesFromBodies(
  count,
  bodies,
  { repositoryRoot = DEFAULT_ROOT } = {},
) {
  const profile = twoMibResidentProfile(count);
  repositoryRoot = resolve(repositoryRoot);
  const rawSources = Object.freeze({
    bios: copyBody(bodies?.bios),
    bootstrap: copyBody(bodies?.bootstrap),
  });
  const biosBody = rawSources.bios.toString("utf8");
  const bootstrapBody = rawSources.bootstrap.toString("utf8");
  const biosEquates = equates({
    BIOSBASE: profile.bios,
    CCP_BASE: profile.ccp,
    BDOSENT: profile.bdosEntry,
    DRIVES: profile.count,
    ALLOCVEC: profile.allocationBase,
  });
  const headers = profile.allocationSlots
    .map(
      ({ drive, start }) =>
        `; Drive ${String.fromCharCode(65 + drive)}: distinct DPH and allocation vector.\n` +
        `DPH${drive}:\n` +
        "        DW      0,0,0,0,DIRBUF,DPBLOCK,CHKSVEC," +
        hex(start),
    )
    .join("\n");
  const bootstrapEquates = equates({
    SYSBASE: profile.ccp,
    BIOSBASE: profile.bios,
    STUBADDR: profile.bootstrapStub,
    CURREC: profile.bootstrapRecord,
    RECSLEFT: profile.bootstrapRemaining,
  });
  const biosSource = `${biosEquates}\n${biosBody}\n${headers}\nDPHEND:\n        DS      BIOSBASE+$400-$,0\n`;
  const bootstrapSource = `${bootstrapEquates}\n${bootstrapBody}`;
  const paths = sourcePaths(repositoryRoot);
  return Object.freeze({
    profile,
    biosSource,
    bootstrapSource,
    sourcePaths: paths,
    repositoryRoot,
    rawSources,
    sourceProvenance: Object.freeze({
      bios: provenance(paths.bios, rawSources.bios, biosSource),
      bootstrap: provenance(
        paths.bootstrap,
        rawSources.bootstrap,
        bootstrapSource,
      ),
    }),
  });
}

function requireLayout(condition, message) {
  if (!condition)
    throw new Error(`invalid two-MiB assembly layout: ${message}`);
}

/** Build only Triptych-owned machine artifacts, independently of CCP/BDOS checkouts. */
export async function assembleTwoMibProfile(count, options) {
  return assemblePreparedTwoMibProfile(
    await prepareTwoMibSources(count, options),
  );
}

/** Assemble the captured prepared strings, never their source-location paths.
 * Copy and validate before the first await so caller mutation cannot retarget
 * assembly or change the provenance returned beside its generated bytes. */
export async function assemblePreparedTwoMibProfile(value) {
  const prepared = prepareTwoMibSourcesFromBodies(
    value?.profile?.count,
    value?.rawSources,
    {
      repositoryRoot: value?.repositoryRoot,
    },
  );
  for (const field of [
    "profile",
    "sourcePaths",
    "sourceProvenance",
    "biosSource",
    "bootstrapSource",
  ])
    requireLayout(
      isDeepStrictEqual(value[field], prepared[field]),
      `captured ${field} disagrees with raw source bodies`,
    );
  const { profile } = prepared;
  const temporary = await mkdtemp(join(tmpdir(), "triptych-2m-atom-"));
  try {
    const biosPath = join(temporary, "BIOS.ASM");
    const bootstrapPath = join(temporary, "BOOT.ASM");
    await Promise.all([
      writeFile(biosPath, prepared.biosSource),
      writeFile(bootstrapPath, prepared.bootstrapSource),
    ]);
    const [bios, bootstrap] = await Promise.all([
      assembleAtomFile(biosPath),
      assembleAtomFile(bootstrapPath),
    ]);
    requireLayout(
      bios.base === profile.bios && bios.bytes.length === 1024,
      "BIOS extent",
    );
    requireLayout(
      bootstrap.base === 0 && bootstrap.bytes.length === 256,
      "bootstrap extent",
    );
    requireLayout(
      bios.labels.COMMONND <= profile.commonLimit,
      "common BIOS budget",
    );
    requireLayout(bios.labels.DPHEADS === profile.dphBase, "DPH table origin");
    requireLayout(
      bios.labels.DPHEND === profile.dphBase + profile.count * 16,
      "configured DPH count",
    );
    for (const { drive, start } of profile.allocationSlots) {
      const address = bios.labels[`DPH${drive}`];
      requireLayout(
        address === profile.dphBase + drive * 16,
        "stable DPH address",
      );
      const offset = address - bios.base + 14;
      requireLayout(
        bios.bytes[offset] + 256 * bios.bytes[offset + 1] === start,
        "ALV pointer",
      );
    }
    return { ...prepared, bios, bootstrap };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
