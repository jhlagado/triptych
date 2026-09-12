import { openDownloads } from "./downloads-fixture.mjs";
import { expect, test, adoptHistoricalMachine } from "./legacy-fixture.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assembleAtomBinary } from "../../../tools/lib/assemble-atom.mjs";
import { decodeDriveSet } from "../../../crates/triptych-host-wasm/web/drive-set.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const imageBytes = 8388608;
const image = (byte = 0) => {
  const result = Buffer.alloc(imageBytes);
  result.fill(byte, 0, 128);
  return result;
};

async function saved(page, historical = false) {
  return page.evaluate(async (historical) => {
    const open = historical
      ? (await import("/saved-machine-store.js")).openSavedMachineStore
      : (await import("/disk-box-app-store.js")).openDiskBoxAppStore;
    const digest = async (bytes) =>
      Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        (value) => value.toString(16).padStart(2, "0"),
      ).join("");
    const store = await open(
      historical ? undefined : { lease: { isOwner: () => false } },
    );
    try {
      const value = await store.load();
      if (value.kind !== "ready") throw new Error(JSON.stringify(value));
      return {
        token: value.token,
        profile: value.snapshot.bootstrap.profile,
        bootstrap: await digest(value.snapshot.bootstrap.bytes),
        A: await digest(value.snapshot.drives.A.bytes),
        B: await digest(value.snapshot.drives.B.bytes),
        backups: await store.listBackups(),
      };
    } finally {
      store.close();
    }
  }, historical);
}

for (const selected of [0, 1]) {
  const drive = selected === 0 ? "A" : "B";
  const other = selected === 0 ? "B" : "A";
  test(`flushing ${drive} saves its checkpoint while dirty ${other} remains unacknowledged`, async ({
    page,
  }, info) => {
    const program = await assembleAtomBinary(
      fileURLToPath(
        new URL(
          `../fixtures/partial-flush-${drive.toLowerCase()}.asm`,
          import.meta.url,
        ),
      ),
    );
    expect(program.length).toBeLessThanOrEqual(256);
    const bootstrap = Buffer.alloc(256);
    bootstrap.set(program);
    await page.route("**/partial-flush-seed", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Partial flush seed</title>",
      }),
    );
    await page.goto("/partial-flush-seed");
    await page.evaluate(async (boot) => {
      const { openSavedMachineStore } = await import("/saved-machine-store.js");
      const store = await openSavedMachineStore();
      try {
        await store.saveCheckpoint(
          { kind: "empty" },
          {
            bootstrap: {
              profile: "triptych-cpu-v0.1-8m-ab",
              bytes: Uint8Array.from(boot),
            },
            drives: {
              A: { name: "test-a.img", bytes: new Uint8Array(8388608) },
              B: { name: "test-b.img", bytes: new Uint8Array(8388608) },
            },
          },
        );
      } finally {
        store.close();
      }
    }, Array.from(bootstrap));
    const initial = await saved(page, true);
    expect(initial.A).toBe(hash(image()));
    expect(initial.B).toBe(hash(image()));

    // An independent real host run proves that the dirty opposite-drive record
    // reached live backing, but never entered its acknowledged checkpoint.
    const observed = await page.evaluate(async (boot) => {
      const wasm = await import("/triptych_host_wasm.js");
      await wasm.default();
      const machine = new wasm.TriptychCpu(Uint8Array.from(boot));
      const digest = async (bytes) =>
        Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (value) => value.toString(16).padStart(2, "0"),
        ).join("");
      try {
        machine.install_drive(0, new Uint8Array(8388608), true);
        machine.install_drive(1, new Uint8Array(8388608), true);
        machine.run_slice(10000, 1000000);
        return {
          halted: machine.last_halted(),
          output: Array.from(machine.serial_output()),
          ready: machine.disk_management_ready(),
          flushes: [machine.drive_flush_count(0), machine.drive_flush_count(1)],
          live: await Promise.all(
            [0, 1].map(async (d) => digest(machine.export_drive(d))),
          ),
          checkpoint: await Promise.all(
            [0, 1].map(async (d) => digest(machine.export_drive_checkpoint(d))),
          ),
        };
      } finally {
        machine.free();
      }
    }, Array.from(bootstrap));
    const expected = [image(), image()];
    expected[selected] = image(0x61 + selected);
    const live = expected.map((bytes) => Buffer.from(bytes));
    live[1 - selected] = image(0x71 + (1 - selected));
    expect(observed).toEqual({
      halted: true,
      output: [70],
      ready: false,
      flushes: selected === 0 ? [1, 0] : [0, 1],
      live: live.map(hash),
      checkpoint: expected.map(hash),
    });

    await adoptHistoricalMachine(page);
    await expect(page.locator("#terminal")).toHaveText("F");
    await expect
      .poll(async () => (await saved(page))[drive])
      .toBe(hash(expected[selected]));
    const durable = await saved(page);
    expect(durable.A).toBe(hash(expected[0]));
    expect(durable.B).toBe(hash(expected[1]));
    expect(durable[other]).toBe(initial[other]);
    expect(durable.bootstrap).toBe(hash(bootstrap));
    expect(durable.profile).toBe(initial.profile);
    expect(durable.backups).toEqual([]);
    expect(durable.token.revision).toBeGreaterThan(initial.token.revision);

    await page.locator("#files").click();
    await page.locator("#saved-and-exited").check();
    await page.locator("#begin-management").click();
    await expect(page.locator("#files-status")).toContainText(
      "Guest storage or input is not idle.",
    );
    await expect(page.locator("#file-import")).toBeDisabled();
    await expect(page.locator("#commit-disk")).toBeDisabled();
    expect(await saved(page)).toEqual(durable);
    await page.locator("#close-files").click();

    const pending = page.waitForEvent("download");
    await openDownloads(page);
    await page.locator("#download-checkpoint-set").click();
    const path = info.outputPath(`flush-${drive}.tds`);
    await (await pending).saveAs(path);
    const downloaded = await decodeDriveSet(await readFile(path));
    expect(Buffer.from(downloaded.bootstrap.bytes)).toEqual(bootstrap);
    expect(downloaded.bootstrap.profile).toBe(initial.profile);
    for (const [index, name] of ["A", "B"].entries()) {
      expect(downloaded.drives[name].name).toBe(
        `test-${name.toLowerCase()}.img`,
      );
      expect(Buffer.from(downloaded.drives[name].bytes)).toEqual(
        expected[index],
      );
    }
    expect(await saved(page)).toEqual(durable);
  });
}
