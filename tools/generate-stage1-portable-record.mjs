import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const fixtureUrl = new URL(
  "../test/conformance/fixtures/atom-stage1-halt.json",
  import.meta.url,
);
const outputUrl = new URL(
  "../test/conformance/records/atom-stage1-triptych.json",
  import.meta.url,
);
const checkOnly = process.argv.includes("--check");

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const readFixture = async () => JSON.parse(await readFile(fixtureUrl, "utf8"));

const fail = (message) => {
  throw new Error(`Stage 1 Triptych record: ${message}`);
};

const recordFor = (fixture) => {
  if (fixture.format !== "triptych.cpu.conformance.fixture.v1") {
    fail(`unsupported fixture format ${fixture.format}`);
  }
  if (fixture.id !== "atom-stage1-halt")
    fail(`unexpected fixture ${fixture.id}`);
  if (
    !fixture.source?.logicalIdentity ||
    !/^[0-9a-f]{64}$/.test(fixture.source.sha256)
  ) {
    fail("fixture source identity is missing or invalid");
  }

  const result = fixture.expected?.result;
  const range = result?.ram?.find((value) => value.address === 0x4000);
  if (!range || range.bytes.length === 0) fail("artifact RAM range is missing");
  const bytes = Uint8Array.from(range.bytes);
  const artifactHash = sha256(bytes);
  if (
    artifactHash !==
    "83eb97a92203f33ccc0839186abcad1a0cc05b857ac46ad30bbb074ef08a1adf"
  ) {
    fail(`artifact hash changed: ${artifactHash}`);
  }

  return {
    schema: "z80-portable-conformance-v1",
    profile: "triptych-cpu-v0.1",
    source: fixture.source,
    artifact: {
      kind: "flat-binary",
      base: range.address,
      end: range.address + bytes.length,
      bytes: [...bytes],
      sha256: artifactHash,
    },
    diagnostic: null,
    execution: {
      status: "halted",
      stop: result.stop,
      steps: result.steps,
      tStates: result.tStates,
      cpu: result.cpu,
      bootRomEnabled: result.bootRomEnabled,
      ramSha256: result.ramSha256,
    },
    provenance: {
      assembler: "atom",
      atomVersion: "0.3.0",
      executionSubstrate: "triptych-rust-cpu",
      compatibleHosts: ["triptych-native", "triptych-wasm"],
      fixture: `${fixture.format}#${fixture.id}`,
    },
  };
};

const expected = `${JSON.stringify(recordFor(await readFixture()), null, 2)}\n`;
if (checkOnly) {
  const actual = await readFile(outputUrl, "utf8");
  if (actual !== expected) {
    throw new Error(
      "Triptych Stage 1 portable record is stale; run npm run generate:stage1-record",
    );
  }
  process.stdout.write("stage-1 Triptych portable record: ok\n");
} else {
  await mkdir(dirname(fileURLToPath(outputUrl)), { recursive: true });
  await writeFile(outputUrl, expected);
  process.stdout.write("stage-1 Triptych portable record: written\n");
}
