import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const firmware = join(root, "firmware", "cpu");
const pins = JSON.parse(
  readFileSync(join(root, "tools", "cpu-firmware-toolchain.json"), "utf8"),
);
const environment = { ...process.env, ESPFLASH_SKIP_UPDATE_CHECK: "true" };

for (const name of ["IDF_PATH", "ESP_IDF_VERSION"]) {
  if (process.env[name]) {
    throw new Error(
      `${name} must be unset; firmware/cpu/.cargo/config.toml owns the ESP-IDF selection`,
    );
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    env: environment,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed${result.stderr ? `:\n${result.stderr}` : ""}`,
    );
  }
  return (result.stdout ?? "").trim();
}

function requireVersion(command, args, expected) {
  const actual = capture(command, args);
  if (actual !== expected) {
    throw new Error(
      `${command} version mismatch\nexpected: ${expected}\nactual:   ${actual}`,
    );
  }
  return actual;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function findByName(directory, wanted, accept = () => true) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findByName(path, wanted, accept);
      if (found) return found;
    } else if (entry.name === wanted && accept(path)) {
      return path;
    }
  }
  return undefined;
}

requireVersion(
  "rustc",
  [`+${pins.rustToolchainName}`, "--version"],
  pins.rustc,
);
requireVersion("espflash", ["--version"], `espflash ${pins.espflash}`);
const ldproxyProbe = spawnSync("ldproxy", [], {
  env: environment,
  encoding: "utf8",
});
if (ldproxyProbe.error) throw ldproxyProbe.error;

capture("cargo", ["build", "--release", "--locked"], {
  cwd: firmware,
  inherit: true,
});

const idfRoot = join(firmware, ".embuild", "espressif", "esp-idf");
const idfCheckout = readdirSync(idfRoot)
  .map((name) => join(idfRoot, name))
  .find((path) => {
    try {
      return (
        capture("git", ["-C", path, "rev-parse", "HEAD"]) === pins.espIdf.commit
      );
    } catch {
      return false;
    }
  });
if (!idfCheckout) {
  throw new Error(
    `no managed ESP-IDF checkout resolves to ${pins.espIdf.commit}`,
  );
}

const elf = join(
  firmware,
  "target",
  pins.target,
  "release",
  "triptych-cpu-firmware",
);
if (!existsSync(elf)) throw new Error(`linked ELF not found: ${elf}`);

const sizeTool = process.env.XTENSA_SIZE || "xtensa-esp32s3-elf-size";
const sizeSummary = capture(sizeTool, [elf]);
const sectionSizes = capture(sizeTool, ["-A", elf]);
const evidenceDirectory = join(firmware, "target", "stage6");
mkdirSync(evidenceDirectory, { recursive: true });
for (const name of readdirSync(evidenceDirectory)) {
  if (name.endsWith(".bin")) unlinkSync(join(evidenceDirectory, name));
}

const imageBase = join(evidenceDirectory, "triptych-cpu-firmware.bin");
const imageOptions = [
  "save-image",
  "--chip",
  "esp32s3",
  "--flash-freq",
  "80mhz",
  // ESP-IDF writes a DIO boot header, then its bootloader enables QIO.
  "--flash-mode",
  "dio",
  "--flash-size",
  "16mb",
];
capture("espflash", [...imageOptions, elf, imageBase], {
  cwd: firmware,
  inherit: true,
});

const buildRoot = join(firmware, "target", pins.target, "release", "build");
const bootloader = findByName(buildRoot, "bootloader.bin");
const sdkconfigSuffix = join("out", "build", "config", "sdkconfig.json");
const sdkconfigJson = findByName(buildRoot, "sdkconfig.json", (path) =>
  path.endsWith(sdkconfigSuffix),
);
const idfBuildJson = findByName(buildRoot, "esp-idf-build.json");
if (!bootloader || !sdkconfigJson || !idfBuildJson) {
  throw new Error("ESP-IDF bootloader/config/build artifacts not found");
}
const idfBuild = JSON.parse(readFileSync(idfBuildJson, "utf8"));
if (!idfBuild.compiler.includes(`/esp-${pins.espIdfManagedGcc}/`)) {
  throw new Error(`unexpected ESP-IDF compiler: ${idfBuild.compiler}`);
}
const partitionCsv = join(
  idfCheckout,
  "components",
  "partition_table",
  "partitions_singleapp_large.csv",
);
const mergedImage = join(evidenceDirectory, "triptych-cpu-firmware-merged.bin");
capture(
  "espflash",
  [
    ...imageOptions,
    "--merge",
    "--skip-padding",
    "--bootloader",
    bootloader,
    "--partition-table",
    partitionCsv,
    elf,
    mergedImage,
  ],
  { cwd: firmware, inherit: true },
);

const sdkconfig = JSON.parse(readFileSync(sdkconfigJson, "utf8"));
const expectedConfiguration = {
  APP_REPRODUCIBLE_BUILD: true,
  ESPTOOLPY_FLASHFREQ_80M: true,
  ESPTOOLPY_FLASHMODE_QIO: true,
  ESPTOOLPY_FLASHSIZE_16MB: true,
  ESP_CONSOLE_SECONDARY_NONE: true,
  ESP_CONSOLE_UART_BAUDRATE: 115200,
  ESP_CONSOLE_UART_DEFAULT: true,
  ESP_MAIN_TASK_STACK_SIZE: 16384,
  ESP_SYSTEM_PANIC_PRINT_HALT: true,
  PARTITION_TABLE_SINGLE_APP_LARGE: true,
  SPIRAM_BOOT_HW_INIT: true,
  SPIRAM_IGNORE_NOTFOUND: false,
  SPIRAM_MEMTEST: true,
  SPIRAM_MODE_OCT: true,
  SPIRAM_SPEED_80M: true,
  SPIRAM_USE_CAPS_ALLOC: true,
  SPIRAM_USE_MALLOC: false,
};
for (const [name, expected] of Object.entries(expectedConfiguration)) {
  if (sdkconfig[name] !== expected) {
    throw new Error(
      `effective sdkconfig ${name}: expected ${expected}, got ${sdkconfig[name]}`,
    );
  }
}

const images = readdirSync(evidenceDirectory)
  .filter((name) => name.endsWith(".bin"))
  .sort()
  .map((name) => {
    const path = join(evidenceDirectory, name);
    return { name, bytes: statSync(path).size, sha256: sha256(path) };
  });
const evidence = {
  format: 1,
  proof: "compile-link-image-only",
  platform: `${process.platform}-${process.arch}`,
  target: pins.target,
  rustc: pins.rustc,
  espIdfCommit: pins.espIdf.commit,
  espIdfManagedGcc: pins.espIdfManagedGcc,
  effectiveSdkconfig: expectedConfiguration,
  elf: { bytes: statSync(elf).size, sha256: sha256(elf) },
  images,
  sizeSummary,
  sectionSizes,
};
writeFileSync(
  join(evidenceDirectory, "build-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(sizeSummary);
console.log(`ELF SHA-256 ${evidence.elf.sha256}`);
for (const image of images)
  console.log(`${image.name} ${image.bytes} bytes ${image.sha256}`);
console.log(`Evidence: ${join(evidenceDirectory, "build-evidence.json")}`);
