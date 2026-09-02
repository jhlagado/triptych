import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareNativeCpm22WorkingImage } from "./cpm22-native-image.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const cpmExecutable = join(
  repositoryRoot,
  "target",
  "debug",
  `triptych-cpm${executableSuffix}`,
);
const hostExecutable = join(
  repositoryRoot,
  "target",
  "debug",
  `triptych-host-native${executableSuffix}`,
);

const sourceImagePath = requiredEnvironment("TRIPTYCH_CPM22_IMAGE");
const atomPath = requiredEnvironment("TRIPTYCH_ATOM_COM");
const atomSourcePath = requiredEnvironment("TRIPTYCH_ATOM_SOURCE");

const atomProvenance = Object.freeze({
  name: "Atom native CP/M 2.2 assembler",
  repository: "https://github.com/jhlagado/debug80/tree/main/packages/atom",
  license: "GPL-3.0-only",
  sha256: "cdd5d05e3131b23288914b354929cfb5c2e1639d71c35f337e8fcec8c2bdfcbb",
});
const atomSourceSha256 =
  "e939a2011c04b5baaffe178c8483363387391a36f3b227a49f7b054d1f71b1db";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must name an external proof input`);
  return resolve(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function run(executable, commandArguments, options = {}) {
  const result = spawnSync(executable, commandArguments, {
    encoding: "latin1",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30_000,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      result.error?.message ??
        result.stderr ??
        result.stdout ??
        `${executable} failed`,
    );
  }
  return result.stdout;
}

function runHost(bootRomPath, diskPath, input, stopAfter) {
  return run(hostExecutable, [
    "--input-ascii",
    input,
    "--stop-after",
    stopAfter,
    "--max-steps",
    "20000000",
    bootRomPath,
    diskPath,
  ]);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

const temporary = await mkdtemp(join(tmpdir(), "triptych-cpm-image-proof-"));
try {
  const [atom, atomSource] = await Promise.all([
    readFile(atomPath),
    readFile(atomSourcePath),
  ]);
  assertEqual(sha256(atom), atomProvenance.sha256, "Atom SHA-256");
  assertEqual(sha256(atomSource), atomSourceSha256, "Atom source SHA-256");

  const workingDisk = join(temporary, "working.img");
  const exportedAtom = join(temporary, "ATOM-exported.COM");
  const exportedSource = join(temporary, "INPUT-exported.ASM");
  run(cpmExecutable, ["create", sourceImagePath, workingDisk]);
  run(cpmExecutable, ["import", workingDisk, atomPath, "ATOM.COM"]);
  run(cpmExecutable, ["import", workingDisk, atomSourcePath, "INPUT.ASM"]);
  const beforeListing = run(cpmExecutable, ["list", workingDisk]);
  if (
    !beforeListing.includes("ATOM.COM") ||
    !beforeListing.includes("INPUT.ASM")
  ) {
    throw new Error(`prepared directory is incomplete:\n${beforeListing}`);
  }
  run(cpmExecutable, ["export", workingDisk, "ATOM.COM", exportedAtom]);
  run(cpmExecutable, [
    "export",
    "--text",
    workingDisk,
    "INPUT.ASM",
    exportedSource,
  ]);
  const [roundTrippedAtom, roundTrippedSource] = await Promise.all([
    readFile(exportedAtom),
    readFile(exportedSource),
  ]);
  if (!roundTrippedAtom.subarray(0, atom.length).equals(atom)) {
    throw new Error("record-padded ATOM.COM export changed the imported bytes");
  }
  if (!roundTrippedAtom.subarray(atom.length).every((byte) => byte === 0x1a)) {
    throw new Error("ATOM.COM export has invalid CP/M record padding");
  }
  if (!roundTrippedSource.equals(atomSource)) {
    throw new Error("text export did not reproduce INPUT.ASM exactly");
  }

  const prepared = await prepareNativeCpm22WorkingImage({
    repositoryRoot,
    workingImagePath: workingDisk,
    outputDirectory: temporary,
  });
  const assembleStop = "OUTPUT.COM written\r\n\r\nA>";
  const assembleTranscript = runHost(
    prepared.bootRomPath,
    prepared.diskPath,
    "ATOM\r",
    assembleStop,
  );
  if (!assembleTranscript.endsWith(assembleStop)) {
    throw new Error(`unexpected Atom transcript: ${assembleTranscript}`);
  }
  const programStop = "Hello from native Atom\r\n\r\nA>";
  const programTranscript = runHost(
    prepared.bootRomPath,
    prepared.diskPath,
    "OUTPUT\r",
    programStop,
  );
  if (!programTranscript.endsWith(programStop)) {
    throw new Error(
      `unexpected assembled-program transcript: ${programTranscript}`,
    );
  }
  const afterListing = run(cpmExecutable, ["list", workingDisk]);
  if (!afterListing.includes("OUTPUT.COM")) {
    throw new Error(
      `guest output is absent from the working image:\n${afterListing}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        host: "native macOS Rust host",
        filesystemWorkflow: ["create", "list", "import", "export"],
        guestWorkflow: ["ATOM", "OUTPUT"],
        persistentGuestFile: "OUTPUT.COM",
        sourceImageSha256: sha256(await readFile(sourceImagePath)),
        atom: atomProvenance,
        atomSourceSha256,
      },
      undefined,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
