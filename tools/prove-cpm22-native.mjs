import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { prepareNativeCpm22Image } from "./cpm22-native-image.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const hostExecutable = join(
  repositoryRoot,
  "target",
  "debug",
  process.platform === "win32"
    ? "triptych-host-native.exe"
    : "triptych-host-native",
);
const cpmImagePath = process.env.TRIPTYCH_CPM22_IMAGE;
if (!cpmImagePath) {
  throw new Error(
    "TRIPTYCH_CPM22_IMAGE must name a provenance-reviewed CP/M 2.2 disk image",
  );
}

function runHost(bootRomPath, diskPath, input, stopAfter) {
  const result = spawnSync(
    hostExecutable,
    [
      "--input-ascii",
      input,
      "--input-after",
      "\r\nA>",
      "--stop-after",
      stopAfter,
      "--max-steps",
      "20000000",
      bootRomPath,
      diskPath,
    ],
    { encoding: "latin1", maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr ?? result.stdout);
  }
  return result.stdout;
}

const temporary = await mkdtemp(join(tmpdir(), "triptych-cpm-native-"));
try {
  const prepared = await prepareNativeCpm22Image({
    repositoryRoot,
    sourceImagePath: cpmImagePath,
    outputDirectory: temporary,
  });
  const { bootRomPath, diskPath } = prepared;

  const firstStop = "Wrote RESULT.TXT\r\n\r\nA>";
  const firstTranscript = runHost(bootRomPath, diskPath, "SMOKE\r", firstStop);
  if (firstTranscript !== `\r\nA>SMOKE\r\r\n${firstStop}`) {
    throw new Error(`unexpected first transcript: ${firstTranscript}`);
  }

  const expectedText = "CP/M file services are working";

  const secondStop = `${expectedText}\r\n\r\nA>`;
  const secondTranscript = runHost(
    bootRomPath,
    diskPath,
    "TYPE RESULT.TXT\r",
    secondStop,
  );
  if (secondTranscript !== `\r\nA>TYPE RESULT.TXT\r\r\n${secondStop}`) {
    throw new Error(`unexpected second transcript: ${secondTranscript}`);
  }

  console.log(
    JSON.stringify(
      {
        status: "passed",
        guest: "Triptych CP/M 2.2 on the native Rust host",
        processes: 2,
        program: "SMOKE.COM",
        persistentFile: "RESULT.TXT",
        sourceImageSha256: prepared.sourceImageSha256,
        workingImageSha256: prepared.workingImageSha256,
      },
      undefined,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
