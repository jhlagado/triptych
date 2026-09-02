import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { assembleTriptychCpuFirmware } from "./cpm22-native-image.mjs";

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

await mkdir(outputDirectory, { recursive: true });
run(wasmBindgen, [
  wasmPath,
  "--out-dir",
  outputDirectory,
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
  const { bootRom, bios } = await assembleTriptychCpuFirmware(repositoryRoot);
  await Promise.all([
    copyFile(
      join(sourceDirectory, "index.html"),
      join(outputDirectory, "index.html"),
    ),
    copyFile(join(sourceDirectory, "app.js"), join(outputDirectory, "app.js")),
    copyFile(
      join(sourceDirectory, "terminal.js"),
      join(outputDirectory, "terminal.js"),
    ),
    copyFile(
      join(sourceDirectory, "style.css"),
      join(outputDirectory, "style.css"),
    ),
    writeFile(join(outputDirectory, "bootstrap.bin"), bootRom),
    writeFile(join(outputDirectory, "bios.bin"), bios),
    writeFile(
      join(outputDirectory, "config.json"),
      `${JSON.stringify({ diskUrl: null, diskName: null }, undefined, 2)}\n`,
      "utf8",
    ),
    writeFile(join(outputDirectory, ".nojekyll"), "", "utf8"),
  ]);
} else {
  await writeFile(
    join(outputDirectory, "package.json"),
    `${JSON.stringify({ type: "commonjs" }, undefined, 2)}\n`,
    "utf8",
  );
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
