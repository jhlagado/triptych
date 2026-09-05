import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const browser = process.argv.includes("--browser");
const conformance = process.argv.includes("--conformance");
if (browser && conformance) {
  throw new Error("browser and conformance builds are separate outputs");
}
const outputDirectory = join(
  repositoryRoot,
  "dist",
  browser ? "wasm-browser" : "wasm",
);
const wasmPath = join(
  repositoryRoot,
  "target",
  "wasm32-unknown-unknown",
  "release",
  "triptych_host_wasm.wasm",
);
const wasmBindgen = process.env.WASM_BINDGEN ?? "wasm-bindgen";
const expectedVersion = "wasm-bindgen 0.2.127";

function run(command, commandArguments) {
  const result = spawnSync(command, commandArguments, {
    cwd: repositoryRoot,
    encoding: "utf8",
    stdio: ["inherit", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      result.error?.message ??
        result.stderr ??
        result.stdout ??
        `${command} failed`,
    );
  }
  return result.stdout.trim();
}

const cargoArguments = [
  "build",
  "--locked",
  "-p",
  "triptych-host-wasm",
  "--target",
  "wasm32-unknown-unknown",
  "--release",
];
if (conformance) cargoArguments.push("--features", "conformance");
run("cargo", cargoArguments);

const version = run(wasmBindgen, ["--version"]);
if (version !== expectedVersion) {
  throw new Error(
    `expected ${expectedVersion}, got ${JSON.stringify(version)}; set WASM_BINDGEN to the pinned executable`,
  );
}

await mkdir(join(repositoryRoot, "dist"), { recursive: true });
const stagingRoot = await mkdtemp(join(repositoryRoot, "dist", ".wasm-build-"));
const stagedOutput = join(stagingRoot, "output");
await mkdir(stagedOutput);
let retainStaging = false;
try {
  run(wasmBindgen, [
    wasmPath,
    "--out-dir",
    stagedOutput,
    "--target",
    browser ? "web" : "nodejs",
    "--typescript",
  ]);
  if (browser) {
    const sourceDirectory = join(
      repositoryRoot,
      "crates",
      "triptych-host-wasm",
      "web",
    );
    const distribution = await buildCpmDistribution(repositoryRoot, {
      allowDirty: !process.argv.includes("--release"),
    });
    const systemDisk = distribution.disk;
    const bootRom = distribution.bootstrap;
    const ccp = systemDisk.slice(0, 0x800);
    const bdos = systemDisk.slice(0x800, 0x1600);
    const bios = systemDisk.slice(0x1600, 0x1a00);
    await Promise.all([
      copyFile(
        join(sourceDirectory, "index.html"),
        join(stagedOutput, "index.html"),
      ),
      copyFile(join(sourceDirectory, "app.js"), join(stagedOutput, "app.js")),
      copyFile(
        join(sourceDirectory, "working-disk-persistence.js"),
        join(stagedOutput, "working-disk-persistence.js"),
      ),
      copyFile(
        join(sourceDirectory, "working-disk-store.js"),
        join(stagedOutput, "working-disk-store.js"),
      ),
      copyFile(
        join(sourceDirectory, "terminal.js"),
        join(stagedOutput, "terminal.js"),
      ),
      copyFile(
        join(sourceDirectory, "style.css"),
        join(stagedOutput, "style.css"),
      ),
      writeFile(join(stagedOutput, "bootstrap.bin"), bootRom),
      writeFile(join(stagedOutput, "ccp.bin"), ccp),
      writeFile(join(stagedOutput, "bdos.bin"), bdos),
      writeFile(join(stagedOutput, "bios.bin"), bios),
      writeFile(join(stagedOutput, "cpm22.img"), systemDisk),
      writeFile(
        join(stagedOutput, "config.json"),
        `${JSON.stringify(
          {
            diskUrl: "cpm22.img",
            diskName: "triptych-cpm22.img",
            systemCcp: "triptych",
          },
          undefined,
          2,
        )}\n`,
        "utf8",
      ),
      writeFile(join(stagedOutput, ".nojekyll"), "", "utf8"),
    ]);
    const assets = [];
    for (const path of (await readdir(stagedOutput)).sort()) {
      const bytes = await readFile(join(stagedOutput, path));
      assets.push({
        path,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
    }
    await writeFile(
      join(stagedOutput, "deployment-manifest.json"),
      `${JSON.stringify(
        {
          schema: "triptych-browser-deployment-v1",
          distribution: distribution.manifest,
          host: {
            wasmBindgen: version,
            cargoLockSha256: createHash("sha256")
              .update(await readFile(join(repositoryRoot, "Cargo.lock")))
              .digest("hex"),
          },
          assets,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    await writeFile(
      join(stagedOutput, "package.json"),
      `${JSON.stringify({ type: "commonjs" }, undefined, 2)}\n`,
      "utf8",
    );
  }

  const previousOutput = join(stagingRoot, "previous");
  let movedPrevious = false;
  try {
    await rename(outputDirectory, previousOutput);
    movedPrevious = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagedOutput, outputDirectory);
  } catch (error) {
    if (movedPrevious) {
      try {
        await rename(previousOutput, outputDirectory);
      } catch (restoreError) {
        retainStaging = true;
        throw new AggregateError(
          [error, restoreError],
          `Could not restore the previous build; retained at ${previousOutput}`,
        );
      }
    }
    throw error;
  }
} finally {
  if (!retainStaging) await rm(stagingRoot, { recursive: true, force: true });
}

console.log(
  JSON.stringify({
    status: "built",
    crate: "triptych-host-wasm",
    target: "wasm32-unknown-unknown",
    wasmBindgen: version,
    conformance,
    browser,
    outputDirectory,
  }),
);
