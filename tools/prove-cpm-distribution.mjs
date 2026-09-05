import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { buildCpmDistribution } from "./lib/cpm-distribution.mjs";
import { readCpm22File } from "./lib/cpm22-disk.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const { TriptychCpu } = require("../dist/wasm/triptych_host_wasm.js");
const built = await buildCpmDistribution(root, {
  allowDirty: process.argv.includes("--allow-dirty"),
});
let machine;
let output = "";
function boot(disk) {
  machine = new TriptychCpu(built.bootstrap);
  machine.install_drive(0, disk, true);
  output = "";
  until("A>");
}
function until(text) {
  for (let i = 0; i < 1500; i++) {
    machine.run_slice(50000, 500000);
    output += Buffer.from(machine.take_serial_output()).toString("latin1");
    if (output.includes(text)) return;
  }
  throw new Error(
    `Timed out waiting for ${JSON.stringify(text)}: ${output.slice(-2000)}`,
  );
}
function send(text, expected = "A>") {
  output = "";
  assert.ok(machine.enqueue_serial_input(Buffer.from(text, "latin1")));
  until(expected);
}
try {
  boot(built.disk);
  send("DIR\r");
  assert.match(output, /ATOM/);
  assert.match(output, /NUC/);
  send("ATOM HELLO.ASM\r");
  assert.match(output, /HELLO.COM written/);
  send("HELLO\r");
  assert.match(output, /Hello from ATOM/);
  send("NUC\r");
  send("OUTPUT\r");
  assert.match(output, /OK/);
  // Edit a new source through the real guest terminal and save with Ctrl-S.
  send("EDIT NEW.NU\r", "NEW");
  send("sub main() fails\rwriteOutputByte('Z') else fail\rend\x13\x11");
  const saved = machine.export_drive(0);
  assert.match(
    Buffer.from(readCpm22File(saved, "NEW.NU")).toString("ascii"),
    /writeOutputByte\('Z'\)/,
  );
  machine.free();
  machine = undefined;
  boot(saved);
  send("NUC NEW.NU\r");
  send("NEW\r");
  assert.match(output, /Z/);
  send("EDIT NEW.NU\r", "writeOutputByte");
  send("\x11");
  console.log(
    JSON.stringify(
      {
        status: "passed",
        diskSha256: built.manifest.disk.sha256,
        triptych: built.manifest.triptych,
        checks: [
          "boot",
          "ATOM compile/run",
          "NUC compile/run",
          "Edit/save",
          "fresh-machine reopen/compile/run",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  machine?.free();
}
