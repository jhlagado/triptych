import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assembleAtomFile } from "./lib/assemble-atom.mjs";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "test/fixtures/large-ab-boot.json");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
assert.ok(process.argv.slice(2).every((arg) => arg === "--check"));
const lock = JSON.parse(await readFile(resolve(root, "package-lock.json")));
const inputs = [
  ["bios", "system/cpm/bios-8m-ab.asm", 0xf900, 1024],
  ["bootstrap", "roms/cpu/bootstrap-8m-ab.asm", 0, 256],
  ["setup", "test/fixtures/large-ab-boot-setup.asm", 0xe300, null],
];
const artifacts = [];
for (const [id, source, base, length] of inputs) {
  const path = resolve(root, source);
  const assembled = await assembleAtomFile(path);
  assert.equal(assembled.base, base);
  if (length !== null) assert.equal(assembled.bytes.length, length);
  else assert.ok(assembled.bytes.length < 256);
  artifacts.push({
    id,
    source,
    sourceSha256: hash(await readFile(path)),
    base,
    bytesSha256: hash(assembled.bytes),
    bytes: [...assembled.bytes],
    labels: Object.fromEntries(
      Object.entries(assembled.labels).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0,
      ),
    ),
  });
}
const generated = `${JSON.stringify(
  {
    format: "triptych.large-ab-boot-fixture.v1",
    description:
      "Actual machine BIOS/bootstrap with synthetic CCP setup; no real OS or application qualification.",
    assembler: lock.packages["node_modules/atom-z80"].resolved,
    artifacts,
  },
  null,
  2,
)}\n`;
if (process.argv.includes("--check")) {
  assert.equal(
    await readFile(output, "utf8"),
    generated,
    "stale A/B boot fixture",
  );
  process.stdout.write("A/B boot fixture matches current ATOM sources.\n");
} else {
  await writeFile(output, generated);
  process.stdout.write("Generated A/B boot fixture.\n");
}
