import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { prepareNativeSavedMachine } from "./lib/native-saved-machine.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = `Usage: node tools/run-saved-machine-native.mjs --archive MACHINE.tds --session NEW_DIRECTORY
       [--deployment deployment-manifest.json] [--host NATIVE_EXECUTABLE]

Opens the saved bootstrap and media in a new private native session. The original
archive and the session files are retained on exit, including interruption.
Session disk files are raw recovery data, not last-flush checkpoint archives.
Two-MiB archives require matching local deployment metadata. Admission checks
descriptor consistency and the saved bootstrap hash, not release authenticity.
Without --deployment, two-MiB metadata is read from dist/wasm-browser when available.
The default host is target/debug/triptych-host-native; build it with Cargo first.
Interactive terminals on macOS and Linux are supported. Ctrl-C stops the host.
`;

export function parseArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]))
    return { help: true };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!["--archive", "--session", "--deployment", "--host"].includes(flag))
      throw new Error(`Unknown option: ${flag}`);
    const name = flag.slice(2);
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(
        `${flag} requires a path (prefix option-like paths with ./)`,
      );
    options[name] = resolve(value);
  }
  if (!options.archive || !options.session)
    throw new Error(
      "Both --archive and --session are required; use --help for usage.",
    );
  return options;
}

function stty(args, capture = false) {
  const result = spawnSync("stty", args, {
    encoding: capture ? "utf8" : undefined,
    stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Terminal configuration failed: ${result.error?.message ?? result.status}`,
    );
  return capture ? result.stdout.trim() : undefined;
}

async function run(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage);
    return;
  }
  if (
    process.platform === "win32" ||
    !process.stdin.isTTY ||
    !process.stdout.isTTY
  )
    throw new Error("This launcher requires a macOS or Linux terminal.");
  const executable =
    options.host ?? join(root, "target/debug/triptych-host-native");
  await access(executable, constants.X_OK);
  const metadata = options.deployment
    ? { deployment: JSON.parse(await readFile(options.deployment, "utf8")) }
    : {
        // Historical archives need no descriptor. Defer optional browser-file
        // reads until the decoded archive actually requires two-MiB admission.
        async loadDeployment() {
          try {
            return JSON.parse(
              await readFile(
                join(root, "dist/wasm-browser/deployment-manifest.json"),
                "utf8",
              ),
            );
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            return undefined;
          }
        },
      };
  const prepared = await prepareNativeSavedMachine({
    archivePath: options.archive,
    outputDirectory: options.session,
    ...metadata,
  });
  console.log("Triptych saved-machine native terminal");
  console.log(`Original archive SHA-256: ${prepared.archiveSha256}`);
  console.log(`Retained archive: ${prepared.retainedArchivePath}`);
  console.log(`Session directory: ${prepared.outputDirectory}`);
  console.log(
    `Resident profile: ${prepared.profile}; configured slots: ${prepared.configuredCount}`,
  );
  for (const slot of prepared.slots)
    if (slot) console.log(`Working drive ${slot.letter}: ${slot.path}`);
  console.log(
    "Session files remain on disk after exit. They are raw recovery data, not checkpoint archives.",
  );
  console.log("Press Ctrl-C to stop.\n");

  let terminalState;
  let child;
  let receivedSignal;
  const handlers = new Map();
  const exitCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  try {
    // Install handlers before changing terminal mode or starting the host.
    // A signal during preparation must not leave raw settings behind.
    for (const signal of Object.keys(exitCodes)) {
      const handler = () => {
        receivedSignal ??= signal;
        if (child && !child.killed) child.kill(signal);
      };
      handlers.set(signal, handler);
      process.on(signal, handler);
    }
    terminalState = stty(["-g"], true);
    stty([
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
    if (!receivedSignal) {
      child = spawn(executable, prepared.argv, { stdio: "inherit" });
      const result = await new Promise((resolveResult, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolveResult({ code, signal }));
      });
      if (!receivedSignal && result.code !== 0)
        throw new Error(
          `Native host exited ${result.signal ?? result.code}; session files were retained.`,
        );
    }
    if (receivedSignal) process.exitCode = exitCodes[receivedSignal];
  } finally {
    try {
      if (terminalState !== undefined) stty([terminalState]);
    } finally {
      for (const [signal, handler] of handlers) process.off(signal, handler);
    }
  }
}

if (
  process.argv[1] &&
  pathToFileURL(await realpath(process.argv[1])).href === import.meta.url
) {
  try {
    await run(process.argv.slice(2));
  } catch (error) {
    console.error(`Saved native session: ${error.message}`);
    process.exitCode = 1;
  }
}
