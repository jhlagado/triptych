import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
// Direct test invocation supports isolated review bindings. The official gate
// always tests the artifact that this invocation builds in this checkout.
const env = {
  ...process.env,
  TRIPTYCH_WASM_MODULE: join(root, "dist/wasm/triptych_host_wasm.js"),
};
for (const args of [
  ["tools/build-wasm-host.mjs"],
  ["--test", "test/wasm/two-mib-files.node.mjs"],
]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error || result.signal || result.status !== 0) {
    throw new Error(
      `WASM disk qualification failed: ${result.error?.message ?? result.signal ?? result.status}`,
    );
  }
}
