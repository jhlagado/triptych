import { openDownloads } from "./downloads-fixture.mjs";
import { expect, test, adoptHistoricalMachine } from "./legacy-fixture.mjs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { assembleAtomBinary } from "../../../tools/lib/assemble-atom.mjs";

test("autosave and recovery download exclude writes after the last guest flush", async ({
  page,
}, testInfo) => {
  // Real guest I/O performs write A -> flush -> write B -> cache eviction.
  // Only the disposable test's bootstrap is replaced; app/store are unmodified.
  const program = await assembleAtomBinary(
    fileURLToPath(new URL("../fixtures/flush-checkpoint.asm", import.meta.url)),
  );
  expect(program.length).toBeLessThanOrEqual(256);
  const boot = Buffer.alloc(256);
  boot.set(program);
  await page.route("**/flush-seed", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/flush-seed");
  await page.evaluate(async (boot) => {
    const { openSavedMachineStore } = await import("/saved-machine-store.js");
    const store = await openSavedMachineStore();
    try {
      const disk = new Uint8Array(
        await (await fetch("/cpm22.img")).arrayBuffer(),
      );
      await store.saveCheckpoint(
        { kind: "empty" },
        {
          bootstrap: { profile: "legacy-e400", bytes: Uint8Array.from(boot) },
          drives: { A: { name: "flush.img", bytes: disk }, B: null },
        },
      );
    } finally {
      store.close();
    }
  }, Array.from(boot));
  await adoptHistoricalMachine(page);
  await expect(page.locator("#status")).toHaveAttribute(
    "data-state",
    "running",
  );

  const savedBytes = () =>
    page.evaluate(async () => {
      const { openDiskBoxAppStore } = await import("/disk-box-app-store.js");
      const store = await openDiskBoxAppStore({
        lease: { isOwner: () => false },
      });
      try {
        const head = await store.load();
        return head.kind === "ready"
          ? Array.from(head.snapshot.drives.A.bytes)
          : [];
      } finally {
        store.close();
      }
    });

  // Wait for guest output to replace the initial boot snapshot. The old bug
  // gives B here; a pending initial save is neither A nor B.
  await expect
    .poll(async () => [65, 66].includes((await savedBytes())[0]))
    .toBe(true);
  const saved = Buffer.from(await savedBytes());
  expect(saved.subarray(0, 128)).toEqual(Buffer.alloc(128, 65));

  const host = await page.evaluate(async (bootBytes) => {
    const { TriptychCpu } = await import("/triptych_host_wasm.js");
    const boot = Uint8Array.from(bootBytes);
    const machine = new TriptychCpu(boot);
    try {
      machine.install_drive(0, new Uint8Array(1024), true);
      const initiallyReady = machine.disk_management_ready();
      const stop = machine.run_slice(10000, 1000000);
      let replacementError;
      let missingError;
      try {
        machine.install_drive(0, new Uint8Array(1024), true);
      } catch (error) {
        replacementError = error.message;
      }
      try {
        machine.export_drive_checkpoint(1);
      } catch (error) {
        missingError = error.message;
      }
      return {
        initiallyReady,
        ready: machine.disk_management_ready(),
        stop,
        flushes: machine.drive_flush_count(0),
        checkpoint: Array.from(machine.export_drive_checkpoint(0)),
        live: Array.from(machine.export_drive(0)),
        replacementError,
        missingError,
      };
    } finally {
      machine.free();
    }
  }, Array.from(boot));
  const expectedCheckpoint = Buffer.alloc(1024);
  expectedCheckpoint.fill(65, 0, 128);
  const expectedLive = Buffer.alloc(1024);
  expectedLive.fill(66, 0, 128);
  expect(host).toEqual({
    initiallyReady: true,
    ready: false,
    stop: 0,
    flushes: 1,
    checkpoint: Array.from(expectedCheckpoint),
    live: Array.from(expectedLive),
    replacementError:
      "drive media cannot change after execution; construct a fresh machine",
    missingError: "drive is not installed",
  });

  const pendingDownload = page.waitForEvent("download");
  await openDownloads(page);
  await page.locator("#download").click();
  const download = await pendingDownload;
  const path = testInfo.outputPath("exact-checkpoint.img");
  await download.saveAs(path);
  expect(await readFile(path)).toEqual(saved);
});
