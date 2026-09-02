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
const systemCcp = process.env.TRIPTYCH_CPM_CCP ?? "oracle";
if (systemCcp !== "oracle" && systemCcp !== "triptych") {
  throw new Error("TRIPTYCH_CPM_CCP must be oracle or triptych");
}
if (systemCcp === "triptych" && workingImagePath !== undefined) {
  throw new Error(
    "the development Triptych CCP preview requires a disposable TRIPTYCH_CPM22_IMAGE, not a persistent working disk",
  );
}
if (!sourceImagePath && !workingImagePath) {
  throw new Error(
    "set TRIPTYCH_CPM22_WORK_DISK to a persistent working image or TRIPTYCH_CPM22_IMAGE to a provenance-reviewed disposable source image",
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
        outputDirectory: temporary,
      })
    : await prepareNativeCpm22Image({
        repositoryRoot,
        sourceImagePath,
        outputDirectory: temporary,
        systemCcp,
      });
  console.log("Triptych native CP/M 2.2 terminal");
  console.log(`Rust host: ${hostExecutable}`);
  console.log(
    `CCP: ${systemCcp === "triptych" ? "Triptych development preview" : "retained compatibility oracle"}`,
  );
  if (persistent) {
    console.log(`Working disk: ${resolve(workingImagePath)}`);
    console.log(`Pre-launch SHA-256: ${prepared.sourceImageSha256}`);
    console.log("Flushed guest writes remain in this working image.");
  } else {
    console.log(`Source disk: ${resolve(sourceImagePath)}`);
    console.log(`Source SHA-256: ${prepared.sourceImageSha256}`);
    console.log(
      "Disk writes go to a temporary copy and are discarded on exit.",
    );
  }
  console.log("Press Ctrl-C to stop.\n");

  savedTerminalState = runStty(["-g"], true);
  runStty(["-echo", "-icanon", "min", "1", "time", "0", "-icrnl", "isig"]);

  child = spawn(hostExecutable, [prepared.bootRomPath, prepared.diskPath], {
    stdio: "inherit",
  });
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
