import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const metadata = JSON.parse(
  await readFile(join(repositoryRoot, "package.json"), "utf8"),
);
const pin = metadata.devDependencies["atom-z80"];
assert.match(
  pin,
  /^git\+https:\/\/github\.com\/jhlagado\/atom\.git#[0-9a-f]{40}$/,
);

// npm 11.16 can omit Git bundles when its cache path traverses a symlink
// (notably /tmp -> /private/tmp on macOS). Use the actual filesystem path.
const temporary = await realpath(
  await mkdtemp(join(tmpdir(), "triptych-atom-install-")),
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    result.error?.message || result.stderr || result.stdout,
  );
  return result.stdout;
}

async function consumer(name) {
  const directory = join(temporary, name);
  await mkdir(directory);
  await writeFile(
    join(directory, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  await writeFile(
    join(directory, "probe.asm"),
    "ORG $4000\nSTART: LD A,42\nJR START\n",
  );
  return directory;
}

const probe = `
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { assembleAtomProject, materializeAtomGeneration } from "atom-z80";
const require = createRequire(import.meta.url);
const atomRequire = createRequire(require.resolve("atom-z80"));
for (const resolver of [require, atomRequire]) {
  for (const directory of resolver.resolve.paths("@jhlagado/azm/compile")) {
    assert.equal(existsSync(join(directory, "@jhlagado", "azm")), false, "AZM must not be installed on the consumer resolution path");
  }
}
const result = await assembleAtomProject({ root: process.cwd(), entry: "probe.asm" });
const { bytes } = materializeAtomGeneration(result.generation, { base: 0x4000 });
assert.deepEqual([...bytes], [0x3e, 42, 0x18, 0xfc]);
const image = readFileSync(require.resolve("atom-z80/cpm22/image"));
const census = JSON.parse(readFileSync(require.resolve("atom-z80/cpm22/census"), "utf8"));
assert.equal(image.length, census.residentBytes);
assert.equal(createHash("sha256").update(image).digest("hex"), census.sha256);
console.log(JSON.stringify({ bytes: bytes.length, cpmImageBytes: image.length, cpmImageSha256: census.sha256 }));
`;

try {
  const online = await consumer("git-consumer");
  run(
    "npm",
    [
      "install",
      "--cache",
      join(temporary, "git-cache"),
      "--no-audit",
      "--no-fund",
      `atom-z80@${pin}`,
    ],
    online,
  );
  const gitResult = JSON.parse(
    run(process.execPath, ["--input-type=module", "--eval", probe], online),
  );

  const [packed] = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
      join(online, "node_modules", "atom-z80"),
    ),
  );
  assert.deepEqual([...packed.bundled].sort(), [
    "@jhlagado/debug80-runtime",
    "@jhlagado/z80-tool-services",
  ]);
  const offline = await consumer("offline-consumer");
  run(
    "npm",
    [
      "install",
      "--offline",
      "--ignore-scripts",
      "--cache",
      join(temporary, "empty-offline-cache"),
      "--no-audit",
      "--no-fund",
      join(temporary, packed.filename),
    ],
    offline,
  );
  const offlineResult = JSON.parse(
    run(process.execPath, ["--input-type=module", "--eval", probe], offline),
  );
  assert.deepEqual(offlineResult, gitResult);
  console.log(
    JSON.stringify(
      { status: "passed", pin, git: gitResult, offline: offlineResult },
      null,
      2,
    ),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
