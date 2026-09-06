import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";
import { buildLargeAbSystem } from "./lib/large-ab-system.mjs";
import { proveLargeAbApps } from "./prove-large-ab-apps.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { CpmDisk } = require("../dist/wasm/triptych_host_wasm.js");
const distribution = await buildCpmDistribution(root, {
  allowDirty: process.argv.includes("--allow-dirty"),
});
const system = await buildLargeAbSystem(root, distribution);
const source = new CpmDisk(distribution.disk);
let image;
try {
  image = Buffer.from(source.migrate_to_eight_mib(system.bytes));
  assert.deepEqual(
    Buffer.from(source.export_source()),
    Buffer.from(distribution.disk),
    "private migration preserves the complete legacy source",
  );
  const migrated = new CpmDisk(image);
  try {
    assert.deepEqual(migrated.file_names(), source.file_names());
    for (const name of source.file_names())
      assert.deepEqual(
        migrated.read_file(name),
        source.read_file(name),
        `migrated ${name}`,
      );
  } finally {
    migrated.free();
  }
} finally {
  source.free();
}
const result = await proveLargeAbApps({
  bootstrap: system.bootstrap,
  drives: [Buffer.from(image), Buffer.from(image)],
  components: system.components,
  resident: system.resident,
});
console.log(
  JSON.stringify(
    {
      status: result.status,
      profile: system.profile,
      checkpoints: result.sessions.reduce(
        (total, session) => total + session.checkpoints.length,
        0,
      ),
      lifetimes: result.sessions.reduce(
        (total, session) => total + session.executions.length,
        0,
      ),
      evidence: result.evidence,
      limits: result.limits,
    },
    null,
    2,
  ),
);
