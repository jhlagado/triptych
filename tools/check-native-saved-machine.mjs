import { spawnSync } from "node:child_process";
import { randomUUID, webcrypto } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const terminal = process.argv.length === 3 && process.argv[2] === "--terminal";
if (process.argv.length !== 2 && !terminal)
  throw new Error(
    "Usage: node tools/check-native-saved-machine.mjs [--terminal]",
  );

const fixtures = await mkdtemp(join(tmpdir(), "triptych-native-saved-check-"));
console.log(`Native saved-machine qualification artifacts: ${fixtures}`);

async function run(command, args, label, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  await writeFile(join(fixtures, `${label}.stdout.log`), stdout, {
    flag: "wx",
  });
  await writeFile(join(fixtures, `${label}.stderr.log`), stderr, {
    flag: "wx",
  });
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.error || result.signal || result.status !== 0)
    throw new Error(
      `${label} failed: ${result.error?.message ?? result.signal ?? result.status}`,
    );
}

try {
  // The enclosing repository gate builds these artifacts before --terminal.
  // Never substitute another checkout or an inherited artifact override.
  const host = join(root, "target/debug/triptych-host-native");
  let CpmDisk;
  if (terminal) {
    await access(host, constants.X_OK);
    ({ CpmDisk } = createRequire(import.meta.url)(
      join(root, "dist/wasm/triptych_host_wasm.js"),
    ));
  }
  // The existing builder verifies retained release identities and assembles
  // private tuples through ATOM. It does not build WASM/Rust or write dist/.
  // Import after allocating the evidence directory so dependency failures also
  // leave an identified report instead of falling back to old fixture paths.
  const { buildTwoMibSystem } = await import("./lib/two-mib-system.mjs");
  let maximum;
  for (let count = 1; count <= 16; count++) {
    const name = `n${String(count).padStart(2, "0")}`;
    const tuple = await buildTwoMibSystem(root, count, { allowDirty: true });
    const directory = join(fixtures, name);
    await mkdir(directory);
    await writeFile(
      join(directory, "descriptor.json"),
      `${JSON.stringify(tuple.descriptor, null, 2)}\n`,
      { flag: "wx" },
    );
    await writeFile(join(directory, "bootstrap.bin"), tuple.bootstrap, {
      flag: "wx",
    });
    await writeFile(join(directory, "system.bin"), tuple.system, {
      flag: "wx",
    });
    if (count === 16)
      maximum = {
        descriptor: tuple.descriptor,
        system: tuple.system,
        bootstrap: tuple.bootstrap,
      };
    console.log(`Captured verified ${name} tuple.`);
  }

  // Override inherited fixture paths. These tests must consume the exact tuples
  // constructed above, and a failed build must never reach the test runner.
  await run(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "tools/lib/native-saved-machine.test.mjs",
      "tools/lib/native-saved-machine-cli.test.mjs",
    ],
    "tests",
    { ...process.env, TRIPTYCH_TWO_MIB_FIXTURES: fixtures },
  );

  if (terminal) {
    const { encodeSavedMachine } =
      await import("../crates/triptych-host-wasm/web/saved-machine.js");
    const slots = [];
    for (let index = 0; index < 16; index++) {
      const letter = String.fromCharCode(65 + index);
      const disk = CpmDisk.create_two_mib();
      try {
        disk.add_import("WHO.TXT", Buffer.from(`Drive ${letter}\r\n`));
        const bytes = disk.export_candidate();
        if (index === 0) bytes.set(maximum.system);
        slots.push({
          instanceId: randomUUID(),
          name: `generated-${letter}.img`,
          bytes,
        });
      } finally {
        disk.free();
      }
    }
    const archive = join(fixtures, "generated-all-sixteen.tds");
    await writeFile(
      archive,
      await encodeSavedMachine(
        {
          schema: "triptych-drive-set-v4",
          configuredCount: 16,
          bootstrap: {
            profile: maximum.descriptor.residentProfile,
            bytes: maximum.bootstrap,
          },
          slots,
        },
        webcrypto,
      ),
      { flag: "wx" },
    );
    const deployment = join(fixtures, "generated-deployment.json");
    await writeFile(
      deployment,
      `${JSON.stringify(
        {
          schema: "triptych-browser-deployment-v1",
          twoMibProfiles: [maximum.descriptor],
          assets: ["system", "bootstrap"].map((role) => ({
            path: maximum.descriptor[role].asset,
            bytes: maximum.descriptor[role].bytes,
            sha256: maximum.descriptor[role].sha256,
          })),
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    console.log(
      "PTY qualification uses a generated archive, not a browser export; all session outputs are retained.",
    );
    await run(
      "python3",
      [
        "tools/prove-saved-native-terminal.py",
        "--archive",
        archive,
        "--deployment",
        deployment,
        "--host",
        host,
        "--output",
        join(fixtures, "generated-terminal-proof"),
      ],
      "generated-terminal",
    );
  }
  console.log(
    `Native saved-machine preparation and CLI${terminal ? ", generated-archive PTY" : ""} checks passed; artifacts retained at ${fixtures}`,
  );
} catch (error) {
  await writeFile(join(fixtures, "failure.txt"), `${error.stack ?? error}\n`, {
    flag: "wx",
  });
  console.error(
    `Native saved-machine gate failed: ${error.message ?? error}; evidence retained at ${fixtures}`,
  );
  process.exitCode = 1;
}
