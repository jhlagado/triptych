import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test.beforeEach(async ({ page }) => {
  // Exercise the actual generated WASM API without booting a CPU or opening
  // persistence. The binding itself must not depend on either host lifecycle.
  await page.route("**/files-binding-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
  );
  await page.goto("/files-binding-test");
});

test("WASM file API matches native filesystem bytes and keeps its source immutable", async ({
  page,
}, testInfo) => {
  const source = Buffer.alloc(256512);
  source.fill(0xe5, 6656, 6656 + 2048);
  const contents = Buffer.alloc(129, 65);
  const diskPath = testInfo.outputPath("native.img");
  const filePath = testInfo.outputPath("hello.txt");
  await writeFile(diskPath, source);
  await writeFile(filePath, contents);
  // The native public CLI and the WASM class independently call the shared
  // filesystem; compare complete images, not only directory metadata.
  execFileSync(
    "cargo",
    [
      "run",
      "--quiet",
      "--locked",
      "-p",
      "triptych-cpm-cli",
      "--bin",
      "triptych-cpm",
      "--",
      "import",
      diskPath,
      filePath,
      "HELLO.TXT",
    ],
    { cwd: repositoryRoot },
  );
  const native = await readFile(diskPath);
  const result = await page.evaluate(
    async ({ source, contents }) => {
      const { default: init, CpmDisk } = await import("/triptych_host_wasm.js");
      await init();
      const input = Uint8Array.from(source);
      const bytes = Uint8Array.from(contents);
      const disk = new CpmDisk(input);
      let candidate;
      try {
        input.fill(3);
        const canonical = CpmDisk.canonical_name("hello.txt");
        const stagedName = disk.add_import("hello.txt", bytes);
        bytes.fill(66);
        candidate = new CpmDisk(disk.export_candidate());
        const first = candidate.read_file("hello.txt");
        first.fill(99);
        const errors = [];
        for (const [name, value] of [
          ["BAD/NAME.NU", [1]],
          ["EMPTY", []],
          ["hello.txt", [2]],
        ]) {
          try {
            disk.add_import(name, Uint8Array.from(value));
          } catch (error) {
            errors.push(error.message);
          }
        }
        const output = {
          canonical,
          stagedName,
          source: Array.from(disk.export_source()),
          candidate: Array.from(disk.export_candidate()),
          sourceNames: disk.file_names(),
          names: candidate.file_names(),
          records: candidate.file_records("hello.txt"),
          readOnly: candidate.file_read_only("HELLO.TXT"),
          freeBytes: candidate.free_bytes(),
          freeEntries: candidate.free_directory_entries(),
          read: Array.from(candidate.read_file("HELLO.TXT")),
          imports: disk.import_count(),
          errors,
        };
        disk.clear_imports();
        output.cleared = disk.import_count();
        output.clearedSource = Array.from(disk.export_candidate());
        return output;
      } finally {
        candidate?.free();
        disk.free();
      }
    },
    { source: Array.from(source), contents: Array.from(contents) },
  );
  expect(result.canonical).toBe("HELLO.TXT");
  expect(result.stagedName).toBe("HELLO.TXT");
  expect(Buffer.from(result.source)).toEqual(source);
  expect(Buffer.from(result.clearedSource)).toEqual(source);
  expect(Buffer.from(result.candidate)).toEqual(native);
  expect(result.sourceNames).toEqual([]);
  expect(result.names).toEqual(["HELLO.TXT"]);
  expect(result.records).toBe(2);
  expect(result.readOnly).toBe(false);
  expect(result.freeBytes).toBe(240 * 1024);
  expect(result.freeEntries).toBe(63);
  expect(Buffer.from(result.read)).toEqual(
    Buffer.concat([contents, Buffer.alloc(127, 0x1a)]),
  );
  expect(result.imports).toBe(1);
  expect(result.cleared).toBe(0);
  expect(result.errors).toHaveLength(3);
  expect(result.errors[0]).toContain("invalid filename");
  expect(result.errors[1]).toContain("at least one byte");
  expect(result.errors[2]).toContain("duplicate import");
});

test("WASM rejects malformed and read-only disks and publishes full-disk batches atomically", async ({
  page,
}) => {
  const result = await page.evaluate(async () => {
    const { default: init, CpmDisk } = await import("/triptych_host_wasm.js");
    await init();
    const blank = new Uint8Array(256512);
    blank.fill(0xe5, 6656, 6656 + 2048);
    const initial = new CpmDisk(blank);
    let full, swapped, locked;
    const errors = {};
    const rejected = (key, callback) => {
      try {
        callback();
      } catch (error) {
        errors[key] = error.message;
      }
    };
    const same = (a, b) =>
      a.length === b.length && a.every((value, index) => value === b[index]);
    try {
      initial.add_import("A.BIN", new Uint8Array(1024).fill(1));
      initial.add_import("B.BIN", new Uint8Array(240 * 1024).fill(2));
      const original = initial.export_candidate();
      full = new CpmDisk(original);
      full.add_import("A.BIN", new Uint8Array(240 * 1024).fill(3));
      rejected("capacity", () => full.export_candidate());
      const failureUnchanged = same(full.export_source(), original);
      full.add_import("B.BIN", new Uint8Array(1024).fill(4));
      swapped = new CpmDisk(full.export_candidate());
      rejected("missing", () => full.read_file("MISSING"));
      const readOnly = original.slice();
      readOnly[6656 + 9] |= 0x80;
      locked = new CpmDisk(readOnly);
      rejected("readOnly", () =>
        locked.add_import("A.BIN", new Uint8Array([0])),
      );
      const malformed = original.slice();
      malformed[6656 + 16] = 1;
      rejected("malformed", () => {
        const bad = new CpmDisk(malformed);
        bad.free();
      });
      rejected("geometry", () => {
        const bad = new CpmDisk(new Uint8Array(512));
        bad.free();
      });
      return {
        errors,
        failureUnchanged,
        sourceUnchanged: same(full.export_source(), original),
        lockedUnchanged: same(locked.export_candidate(), readOnly),
        lockedFlag: locked.file_read_only("A.BIN"),
        free: swapped.free_bytes(),
        a: swapped.read_file("A.BIN").every((value) => value === 3),
        b: swapped.read_file("B.BIN").every((value) => value === 4),
        aRecords: swapped.file_records("A.BIN"),
        bRecords: swapped.file_records("B.BIN"),
      };
    } finally {
      locked?.free();
      swapped?.free();
      full?.free();
      initial.free();
    }
  });
  expect(result.failureUnchanged).toBe(true);
  expect(result.sourceUnchanged).toBe(true);
  expect(result.lockedUnchanged).toBe(true);
  expect(result.lockedFlag).toBe(true);
  expect(result.free).toBe(0);
  expect(result.a).toBe(true);
  expect(result.b).toBe(true);
  expect(result.aRecords).toBe(1920);
  expect(result.bRecords).toBe(8);
  expect(result.errors.capacity).toContain("no room");
  expect(result.errors.missing).toContain("does not exist");
  expect(result.errors.readOnly).toContain("read-only");
  expect(result.errors.malformed).toBeTruthy();
  expect(result.errors.geometry).toContain("exactly");
});
