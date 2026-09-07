import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const word = (bytes, at, value) => {
  bytes[at] = value & 255;
  bytes[at + 1] = value >>> 8;
};

/** Independent synthetic contract fixture, not executable OS or build evidence.
 * No production profile generator, assembler or system builder is imported.
 */
function tuple(count, machine) {
  const suffix = `n${String(count).padStart(2, "0")}`;
  const residentProfile = `triptych-cpu-v0.1-2m-${suffix}`;
  const allocationBytes = 256 * Math.ceil(count / 2);
  const allocationBase = 65536 - allocationBytes;
  const biosBase = allocationBase - 1024;
  const bdos = allocationBase - 4608;
  const ccp = allocationBase - 6656;
  const system = new Uint8Array(16384);
  system.fill(32 + Math.ceil(count / 2), 0, 2048);
  system.fill(64 + Math.ceil(count / 2), 2048, 5632);
  const bios = system.subarray(5632, 6656);
  bios[27] = 0xc3;
  word(bios, 28, biosBase + 80);
  bios.set([0x79, 0xfe, count, 0x21, 0, 0, 0xd0], 80);
  const dpbOffset = 448;
  const directoryOffset = dpbOffset + 15;
  const checksumOffset = directoryOffset + 128;
  const commonEndOffset = checksumOffset + 32;
  bios.set([128, 0, 4, 15, 0, 247, 3, 255, 3, 255, 255, 0, 0, 1, 0], dpbOffset);
  for (let drive = 0; drive < count; drive++) {
    const at = 768 + drive * 16;
    word(bios, at + 8, biosBase + directoryOffset);
    word(bios, at + 10, biosBase + dpbOffset);
    word(bios, at + 12, biosBase + checksumOffset);
    word(bios, at + 14, allocationBase + drive * 128);
  }
  const bootstrap = new Uint8Array(256);
  bootstrap.set([0xf3, 0x31]);
  word(bootstrap, 2, ccp - 256);
  word(bootstrap, 16, ccp - 272);
  bootstrap[19] = 52;
  word(bootstrap, 21, ccp - 271);
  word(bootstrap, 24, ccp);
  const source = (path, preparation = path) => ({
    source: path,
    sourceSha256: sha256(path),
    preparedSourceSha256: sha256(preparation),
  });
  const retained = "third_party/portable-cpm/2m/v0.1.4";
  const descriptor = {
    schema: "triptych-two-mib-system-v1",
    id: "triptych-cpm-2m-v1",
    residentProfile,
    configuredCount: count,
    imageBytes: 2097152,
    systemBytes: 16384,
    layout: {
      ccp,
      bdos,
      bios: biosBase,
      allocationBase,
      allocationBytes,
      commonLimit: biosBase + 768,
      dphBase: biosBase + 768,
      dphEnd: biosBase + 768 + count * 16,
    },
    system: {
      asset: `system-triptych-cpm-2m-${suffix}-v1.bin`,
      bytes: 16384,
      sha256: sha256(system),
    },
    bootstrap: {
      asset: `bootstrap-triptych-cpm-2m-${suffix}-v1.bin`,
      bytes: 256,
      sha256: sha256(bootstrap),
      ...source("roms/cpu/bootstrap-2m.asm", `bootstrap ${ccp}`),
    },
    residents: {
      lock: `distribution/residents-2m/${suffix}.lock.json`,
      lockSha256: sha256(`lock ${suffix}`),
      manifest: `${retained}/profiles/${residentProfile}/manifest.json`,
      manifestSha256: sha256(`manifest ${suffix}`),
      repository: "https://github.com/jhlagado/portable-cpm.git",
      version: "0.1.4",
      revision: "d28fc52774c967d1422b3b814d51c069247504c1",
      ccp: {
        ...source(`${retained}/src/ccp.asm`, `ccp ${ccp}`),
        sha256: sha256(system.subarray(0, 2048)),
        offset: 0,
        origin: ccp,
        bytes: 2048,
      },
      bdos: {
        ...source(`${retained}/src/bdos.asm`, `bdos ${bdos}`),
        sha256: sha256(system.subarray(2048, 5632)),
        offset: 2048,
        origin: bdos,
        bytes: 3584,
      },
    },
    bios: {
      ...source("system/cpm/bios-2m.asm", `bios ${count}`),
      sha256: sha256(bios),
      commonEnd: biosBase + commonEndOffset,
      directoryBuffer: biosBase + directoryOffset,
      dpb: biosBase + dpbOffset,
      checksumVector: biosBase + checksumOffset,
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
      ...machine,
      generator: "tools/lib/cpm-two-mib-profile.mjs",
      generatorSha256: sha256("synthetic generator identity"),
    },
  };
  return { descriptor, system, bootstrap };
}

/** Add optional two-MiB fixture assets without changing historical profiles. */
export async function addTwoMibDeploymentFixture(
  directory,
  manifest,
  counts = Array.from({ length: 16 }, (_, index) => index + 1),
) {
  const tuples = counts.map((count) =>
    tuple(count, manifest.distribution.triptych),
  );
  manifest.twoMibProfiles = tuples.map(({ descriptor }) => descriptor);
  if (tuples.length) {
    const { packageIntegrity, ...atom } = tuples[0].descriptor.atom;
    manifest.distribution.atom = structuredClone(atom);
  }
  const assets = new Map([
    [
      "two-mib-system.js",
      Buffer.from("// Synthetic module presence fixture.\n"),
    ],
    [
      "drive-set-v4.js",
      Buffer.from("// Synthetic dependency presence fixture.\n"),
    ],
  ]);
  for (const value of tuples) {
    assets.set(value.descriptor.system.asset, value.system);
    assets.set(value.descriptor.bootstrap.asset, value.bootstrap);
  }
  for (const [path, bytes] of assets) {
    await writeFile(join(directory, path), bytes, { flag: "wx" });
    manifest.assets.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }
  return tuples;
}
