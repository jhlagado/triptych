import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const fixtures = await mkdtemp(join(tmpdir(), "triptych-two-mib-check-"));
console.log(`Two-MiB qualification artifacts: ${fixtures}`);

function check(files, concurrency) {
  const result = spawnSync(
    process.execPath,
    ["--test", `--test-concurrency=${concurrency}`, ...files],
    {
      cwd: root,
      stdio: "inherit",
      env: {
        ...process.env,
        TRIPTYCH_TWO_MIB_FIXTURE_ROOT: fixtures,
        TRIPTYCH_TWO_MIB_FIXTURES: fixtures,
      },
    },
  );
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `Two-MiB gate failed (${result.error?.message ?? result.signal ?? result.status}); captured artifacts retained at ${fixtures}`,
    );
  }
}

// Assemble each profile once, then test those exact captured bytes through
// both browser APIs. A failed builder cannot fall through to stale fixtures.
check(["tools/lib/two-mib-system.test.mjs"], 1);
check(
  [
    "test/wasm/two-mib-system.node.mjs",
    "test/wasm/two-mib-system-artifacts.node.mjs",
  ],
  2,
);
console.log(`Two-MiB construction and browser admission passed: ${fixtures}`);
