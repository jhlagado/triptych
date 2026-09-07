import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

// Run against the generated Node WASM binding, not a filesystem model double.
const require = createRequire(import.meta.url);
const modulePath = process.env.TRIPTYCH_WASM_MODULE
  ? resolve(process.env.TRIPTYCH_WASM_MODULE)
  : resolve(import.meta.dirname, "../../dist/wasm/triptych_host_wasm.js");
const { CpmDisk } = require(modulePath);
const imageBytes = 2097152;
const systemBytes = 16384;
const fileCapacity = 2048000;

function withDisk(create, action) {
  const disk = create();
  try {
    return action(disk);
  } finally {
    disk.free();
  }
}

function entry(bytes, name, entries) {
  const [stem, extension = ""] = name.split(".");
  const encoded = stem.padEnd(8) + extension.padEnd(3);
  for (
    let offset = systemBytes;
    offset < systemBytes + entries * 32;
    offset += 32
  ) {
    if (bytes[offset] === 0xe5) continue;
    const actual = String.fromCharCode(
      ...bytes.subarray(offset + 1, offset + 12).map((byte) => byte & 0x7f),
    );
    if (actual === encoded) return offset;
  }
  assert.fail(`missing directory entry ${name}`);
}

test("WASM creates independent data-only two-MiB disks and owned staged bytes", () => {
  withDisk(CpmDisk.create_two_mib, (first) => {
    withDisk(CpmDisk.create_two_mib, (second) => {
      const original = second.export_source();
      assert.equal(first.geometry_id(), "triptych-cpm-2m-v1");
      assert.equal(original.length, imageBytes);
      assert(original.subarray(0, systemBytes).every((byte) => byte === 0));
      assert.equal(first.free_bytes(), fileCapacity);
      assert.equal(first.free_directory_entries(), 1024);
      assert.deepEqual(first.file_names(), []);
      assert.deepEqual(first.export_source(), original);
      const exported = first.export_source();
      exported.fill(0x66);
      const input = new Uint8Array(129).fill(0x41);
      first.add_import("HELLO.TXT", input);
      input.fill(0x42);
      const candidate = first.export_candidate();
      withDisk(
        () => new CpmDisk(candidate),
        (reopened) => {
          assert.equal(reopened.file_records("HELLO.TXT"), 2);
          const actual = reopened.read_file("HELLO.TXT");
          assert.deepEqual(
            actual.subarray(0, 129),
            new Uint8Array(129).fill(0x41),
          );
          assert(actual.subarray(129).every((byte) => byte === 0x1a));
        },
      );
      assert.deepEqual(first.export_source(), original);
      assert.deepEqual(second.export_candidate(), original);
      first.clear_imports();
      assert.deepEqual(first.export_candidate(), original);
    });
  });
});

test("WASM two-MiB migration preserves user 15, attributes, empty files and source bytes", () => {
  const source = withDisk(CpmDisk.create_eight_mib, (disk) => {
    disk.add_import("ZERO.TXT", new Uint8Array(129).fill(0x31));
    disk.add_import("USER15.TXT", new Uint8Array(65).fill(0x75));
    disk.add_import("EMPTY.TXT", Uint8Array.of(1));
    return disk.export_candidate();
  });
  source.subarray(0, systemBytes).fill(0x39);
  const user = entry(source, "USER15.TXT", 512);
  source[user] = 15;
  for (const field of [9, 10, 11]) source[user + field] |= 0x80;
  const empty = entry(source, "EMPTY.TXT", 512);
  source[empty + 15] = 0;
  source.fill(0, empty + 16, empty + 32);
  const original = source.slice();
  const system = new Uint8Array(systemBytes).fill(0x52);
  withDisk(
    () => new CpmDisk(source),
    (disk) => {
      const migrated = disk.migrate_to_two_mib(system);
      assert.equal(migrated.length, imageBytes);
      assert.deepEqual(migrated.subarray(0, systemBytes), system);
      const targetUser = entry(migrated, "USER15.TXT", 1024);
      assert.deepEqual(
        migrated.subarray(targetUser, targetUser + 16),
        source.subarray(user, user + 16),
      );
      const block =
        migrated[targetUser + 16] | (migrated[targetUser + 17] << 8);
      const contents = migrated.subarray(
        systemBytes + block * 2048,
        systemBytes + block * 2048 + 128,
      );
      assert(contents.subarray(0, 65).every((byte) => byte === 0x75));
      assert(contents.subarray(65).every((byte) => byte === 0x1a));
      withDisk(
        () => new CpmDisk(migrated),
        (reopened) => {
          assert.equal(reopened.geometry_id(), "triptych-cpm-2m-v1");
          assert.deepEqual(
            reopened.read_file("ZERO.TXT"),
            disk.read_file("ZERO.TXT"),
          );
          assert.equal(reopened.file_records("EMPTY.TXT"), 0);
          assert.equal(reopened.read_file("EMPTY.TXT").length, 0);
          assert.throws(
            () => reopened.read_file("USER15.TXT"),
            /does not exist in user 0/,
          );
        },
      );
      migrated.fill(0);
      system.fill(0);
      assert.deepEqual(disk.export_source(), original);
      assert.deepEqual(source, original);
    },
  );
});

test("WASM rejects non-fitting two-MiB migration without changing its source", () => {
  const source = withDisk(CpmDisk.create_eight_mib, (disk) => {
    disk.add_import("LARGE.BIN", new Uint8Array(fileCapacity + 128).fill(0x59));
    return disk.export_candidate();
  });
  withDisk(
    () => new CpmDisk(source),
    (disk) => {
      assert.throws(
        () => disk.migrate_to_two_mib(new Uint8Array(systemBytes)),
        /insufficient capacity/,
      );
      assert.deepEqual(disk.export_source(), source);
      assert.deepEqual(disk.export_candidate(), source);
      assert.equal(disk.import_count(), 0);
    },
  );
});

test("WASM rejects malformed system lengths and pending batches in both migration APIs", () => {
  withDisk(CpmDisk.create_two_mib, (disk) => {
    const original = disk.export_source();
    for (const method of ["migrate_to_two_mib", "migrate_to_eight_mib"]) {
      for (const length of [0, 128, systemBytes - 1, systemBytes + 1]) {
        assert.throws(() => disk[method](new Uint8Array(length)));
        assert.deepEqual(disk.export_source(), original);
      }
      disk.add_import("STAGED.TXT", Uint8Array.of(65));
      const before = disk.export_candidate();
      assert.throws(
        () => disk[method](new Uint8Array(systemBytes)),
        /Clear staged imports/,
      );
      assert.equal(disk.import_count(), 1);
      assert.deepEqual(disk.export_source(), original);
      assert.deepEqual(disk.export_candidate(), before);
      disk.clear_imports();
    }
  });
});
