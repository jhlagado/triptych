import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import { parseArguments } from "../run-saved-machine-native.mjs";
import { execFileSync } from "node:child_process";
import { mkdtemp, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("archive launcher accepts explicit paths without a shell or profile inference", () => {
  assert.deepEqual(
    parseArguments([
      "--archive",
      "machine.tds",
      "--session",
      "new session",
      "--deployment",
      "retained.json",
      "--host",
      "bin/host",
    ]),
    {
      archive: resolve("machine.tds"),
      session: resolve("new session"),
      deployment: resolve("retained.json"),
      host: resolve("bin/host"),
    },
  );
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.deepEqual(parseArguments(["-h"]), { help: true });
});

test("archive launcher rejects ambiguous or incomplete options before creating files", () => {
  for (const argv of [
    [],
    ["--archive"],
    ["--session", "x"],
    ["--archive", "x"],
    ["--archive", "x", "--session", "--host"],
    ["--archive", "x", "--session", "y", "--archive", "z"],
    ["--archive", "x", "--session", "y", "--unknown", "z"],
    ["--help", "--archive", "x"],
  ])
    assert.throws(() => parseArguments(argv));
});

test("the real launcher prints help when invoked through a symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "triptych-native-cli-link-"));
  const launcher = fileURLToPath(
    new URL("../run-saved-machine-native.mjs", import.meta.url),
  );
  const linked = join(directory, "terminal.mjs");
  try {
    await symlink(launcher, linked);
    for (const path of [launcher, linked]) {
      const output = execFileSync(process.execPath, [path, "--help"], {
        encoding: "utf8",
      });
      assert.match(output, /Usage: node tools\/run-saved-machine-native.mjs/);
      assert.match(output, /raw recovery data/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
