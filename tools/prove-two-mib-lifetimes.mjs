import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runTwoMibLifetimeMatrix } from "./lib/two-mib-lifetime-matrix.mjs";

// Requires existing native/WASM hosts. This gate never rebuilds them or changes
// retained tool pins. Historical A/B arenas retain their separate required gate.
const args = process.argv.slice(2);
assert(
  args.length === 0 || (args.length === 1 && args[0] === "--allow-dirty"),
  "usage: node tools/prove-two-mib-lifetimes.mjs [--allow-dirty]",
);
const root = fileURLToPath(new URL("../", import.meta.url));
const proof = fileURLToPath(
  new URL("./prove-large-ab-limits.mjs", import.meta.url),
);
const started = performance.now();
const result = await runTwoMibLifetimeMatrix(
  ({ count, suite }) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          proof,
          ...args,
          `--two-mib-count=${count}`,
          ...(suite ? [`--suite=${suite}`] : []),
        ],
        { cwd: root, stdio: "inherit" },
      );
      let failure;
      child.once("error", (error) => {
        failure = error;
      });
      child.once("close", (code, signal) => {
        if (failure) reject(failure);
        else if (code !== 0 || signal !== null)
          reject(new Error(`proof exited with code ${code}, signal ${signal}`));
        else resolve();
      });
    }),
);
console.log(
  JSON.stringify(
    {
      status: "passed",
      ...result,
      elapsedMs: Math.round(performance.now() - started),
      maximumParallelProofs: 2,
    },
    null,
    2,
  ),
);
