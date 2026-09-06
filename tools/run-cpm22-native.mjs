import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  prepareNativeCpm22Image,
  prepareNativeCpm22WorkingImage,
} from "./cpm22-native-image.mjs";

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
const sourceImagePath = process.env.TRIPTYCH_CPM22_IMAGE;
const workingImagePath = process.env.TRIPTYCH_CPM22_WORK_DISK;
const workingImagePathB = process.env.TRIPTYCH_CPM22_WORK_DISK_B;
const bootstrapProfile = process.env.TRIPTYCH_CPM_BOOTSTRAP_PROFILE;
const systemCcp = process.env.TRIPTYCH_CPM_CCP ?? "triptych";
if (workingImagePathB !== undefined && workingImagePath === undefined) {
  throw new Error(
    "drive B requires saved drive A through TRIPTYCH_CPM22_WORK_DISK",
  );
}
if (
  workingImagePathB !== undefined &&
  bootstrapProfile !== "triptych-cpu-v0.1-8m-ab"
) {
  throw new Error(
    "drive B requires explicit TRIPTYCH_CPM_BOOTSTRAP_PROFILE=triptych-cpu-v0.1-8m-ab",
  );
}
if (systemCcp !== "oracle" && systemCcp !== "triptych") {
  throw new Error("TRIPTYCH_CPM_CCP must be oracle or triptych");
}
if (
  workingImagePath !== undefined &&
  process.env.TRIPTYCH_CPM_CCP !== undefined
) {
  throw new Error(
    "TRIPTYCH_CPM_CCP cannot replace the CCP in a saved working disk; use an explicit disposable source copy",
  );
}
if (workingImagePath !== undefined && sourceImagePath !== undefined) {
  throw new Error(
    "choose either TRIPTYCH_CPM22_WORK_DISK or the disposable TRIPTYCH_CPM22_IMAGE source",
  );
}
if (workingImagePath === undefined && bootstrapProfile !== undefined) {
  throw new Error(
    "TRIPTYCH_CPM_BOOTSTRAP_PROFILE selects the known resident layout of a saved TRIPTYCH_CPM22_WORK_DISK only",
  );
}
if (process.platform === "win32") {
  throw new Error(
    "the interactive launcher currently supports macOS and Linux terminals",
  );
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error("the interactive launcher requires a terminal");
}

function runStty(sttyArguments, capture = false) {
  const result = spawnSync("stty", sttyArguments, {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`stty ${sttyArguments.join(" ")} failed`);
  }
  return capture ? result.stdout.trim() : undefined;
}

function waitForChild(child) {
  return new Promise((resolveResult, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveResult({ code, signal }));
  });
}

const temporary = await mkdtemp(join(tmpdir(), "triptych-cpm-native-"));
let savedTerminalState;
let child;
let receivedSignal;
const signalHandlers = new Map();

try {
  const persistent = workingImagePath !== undefined;
  const prepared = persistent
    ? await prepareNativeCpm22WorkingImage({
        repositoryRoot,
        workingImagePath,
        workingImagePathB,
        outputDirectory: temporary,
        bootstrapProfile,
      })
    : await prepareNativeCpm22Image({
        repositoryRoot,
        sourceImagePath,
        outputDirectory: temporary,
        systemCcp,
      });
  console.log("Triptych native CP/M 2.2 terminal");
  console.log(`Rust host: ${hostExecutable}`);
  if (persistent) {
    for (const drive of prepared.drives) {
      console.log(`Working drive ${drive.letter}: ${drive.path}`);
      console.log(`Drive ${drive.letter} pre-launch SHA-256: ${drive.sha256}`);
    }
    console.log(`Selected bootstrap profile: ${prepared.bootstrapProfile}`);
    console.log(
      "Saved system and application bytes are preserved exactly; resident compatibility is the caller's selection, not inferred from disk capacity.",
    );
    console.log("Flushed guest writes remain in their named working images.");
  } else if (sourceImagePath !== undefined) {
    console.log(
      `CCP: ${systemCcp === "triptych" ? "pinned Portable CP/M release" : "retained compatibility oracle"}`,
    );
    console.log(`Source disk: ${resolve(sourceImagePath)}`);
    console.log(`Source SHA-256: ${prepared.sourceImageSha256}`);
    console.log(
      "Disk writes go to a temporary copy and are discarded on exit.",
    );
  } else {
    console.log(
      "Source disk: fresh pinned CP/M distribution (development build)",
    );
    console.log(`Distribution manifest: ${prepared.distributionManifestPath}`);
    console.log(`Disk SHA-256: ${prepared.workingImageSha256}`);
    console.log("Disk writes are disposable and are discarded on exit.");
  }
  console.log("Press Ctrl-C to stop.\n");

  savedTerminalState = runStty(["-g"], true);
  runStty([
    "-echo",
    "-icanon",
    "min",
    "1",
    "time",
    "0",
    "-icrnl",
    "-ixon",
    "-ixoff",
    "-opost",
    "isig",
  ]);

  child = spawn(
    hostExecutable,
    [prepared.bootRomPath, ...(prepared.diskPaths ?? [prepared.diskPath])],
    {
      stdio: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      receivedSignal ??= signal;
      if (!child.killed) {
        child.kill(signal);
      }
    };
    signalHandlers.set(signal, handler);
    process.on(signal, handler);
  }

  const result = await waitForChild(child);
  if (result.code !== 0 && receivedSignal === undefined) {
    throw new Error(
      result.signal === null
        ? `native host exited with status ${result.code}`
        : `native host exited after ${result.signal}`,
    );
  }
  if (receivedSignal !== undefined) {
    process.exitCode = receivedSignal === "SIGINT" ? 130 : 143;
  }
} finally {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  if (savedTerminalState !== undefined) {
    runStty([savedTerminalState]);
  }
  await rm(temporary, { recursive: true, force: true });
}
