import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
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
const CCP_SYSTEM_OFFSET = 0x0000;
const BDOS_SYSTEM_OFFSET = 0x0800;
const BIOS_SYSTEM_OFFSET = 0x1600;
const bundledDiskPath = join(
  repositoryRoot,
  "third_party",
  "cpm22",
  "cpm22.img",
);
const bundledDiskSha256 =
  "7d2898386a77ff3c1e84b0141dad251a19be795befadb7dd8a9ba5965ba4654f";

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
  const [{ bootRom, ccp, bdos, bios }, bundledDisk] = await Promise.all([
    assembleTriptychCpuFirmware(repositoryRoot),
    readFile(bundledDiskPath),
  ]);
  const actualDiskSha256 = createHash("sha256")
    .update(bundledDisk)
    .digest("hex");
  if (actualDiskSha256 !== bundledDiskSha256) {
    throw new Error(
      `bundled CP/M disk digest changed: expected ${bundledDiskSha256}, got ${actualDiskSha256}`,
    );
  }
  const systemDisk = Uint8Array.from(bundledDisk);
  systemDisk.set(ccp, CCP_SYSTEM_OFFSET);
  systemDisk.set(bdos, BDOS_SYSTEM_OFFSET);
  systemDisk.set(bios, BIOS_SYSTEM_OFFSET);
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
    writeFile(join(outputDirectory, "ccp.bin"), ccp),
    writeFile(join(outputDirectory, "bdos.bin"), bdos),
    writeFile(join(outputDirectory, "bios.bin"), bios),
    writeFile(join(outputDirectory, "cpm22.img"), systemDisk),
    writeFile(
      join(outputDirectory, "config.json"),
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
