import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assembleAtomFile } from "./assemble-atom.mjs";

const BIOS_SOURCE = new URL("../../system/cpm/bios-2m.asm", import.meta.url);
const BOOTSTRAP_SOURCE = new URL(
  "../../roms/cpu/bootstrap-2m.asm",
  import.meta.url,
);
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

/** Produce flat, guest-assemblable ATOM text; no source substitution or relocation. */
export async function prepareTwoMibSources(count) {
  const profile = twoMibResidentProfile(count);
  const [biosBody, bootstrapBody] = await Promise.all([
    readFile(BIOS_SOURCE, "utf8"),
    readFile(BOOTSTRAP_SOURCE, "utf8"),
  ]);
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
  return {
    profile,
    biosSource: `${biosEquates}\n${biosBody}\n${headers}\nDPHEND:\n        DS      BIOSBASE+$400-$,0\n`,
    bootstrapSource: `${bootstrapEquates}\n${bootstrapBody}`,
    sourcePaths: {
      bios: fileURLToPath(BIOS_SOURCE),
      bootstrap: fileURLToPath(BOOTSTRAP_SOURCE),
    },
  };
}

function requireLayout(condition, message) {
  if (!condition)
    throw new Error(`invalid two-MiB assembly layout: ${message}`);
}

/** Build only Triptych-owned machine artifacts, independently of CCP/BDOS checkouts. */
export async function assembleTwoMibProfile(count) {
  const prepared = await prepareTwoMibSources(count);
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
      bios.labels.DPHEND === profile.dphBase + count * 16,
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
