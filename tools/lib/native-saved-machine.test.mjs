import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { test } from "node:test";
import { prepareNativeSavedMachine } from "./native-saved-machine.mjs";
import { encodeSavedMachine } from "../../crates/triptych-host-wasm/web/saved-machine.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureRoot = process.env.TRIPTYCH_TWO_MIB_FIXTURES;
let captured;
async function fixtures() {
  if (!captured) {
    assert.ok(
      fixtureRoot,
      "Set TRIPTYCH_TWO_MIB_FIXTURES to captured n01–n16 real release tuples; tests never assemble them.",
    );
    captured = await Promise.all(
      Array.from({ length: 16 }, async (_, index) => {
        const path = join(
          fixtureRoot,
          `n${String(index + 1).padStart(2, "0")}`,
        );
        const descriptor = JSON.parse(
          await fs.readFile(join(path, "descriptor.json"), "utf8"),
        );
        const bootstrap = await fs.readFile(join(path, "bootstrap.bin"));
        const system = await fs.readFile(join(path, "system.bin"));
        assert.equal(hash(bootstrap), descriptor.bootstrap.sha256);
        assert.equal(hash(system), descriptor.system.sha256);
        return { descriptor, bootstrap, system };
      }),
    );
  }
  return captured;
}
async function twoMib(count) {
  const tuples = await fixtures();
  const tuple = tuples[count - 1];
  const bytes = new Uint8Array(2097152);
  bytes.set(tuple.system);
  // Deliberate saved guest changes must survive without fresh resident overlay.
  bytes[0] ^= 0x7f;
  bytes[6000] ^= 0x55;
  bytes[18000] = 0x92;
  const snapshot = {
    schema: "triptych-drive-set-v4",
    configuredCount: count,
    bootstrap: {
      profile: tuple.descriptor.residentProfile,
      bytes: tuple.bootstrap,
    },
    slots: Array.from({ length: count }, (_, index) => ({
      instanceId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: "../../same-dangerous-name.img",
      bytes: bytes.slice(),
    })),
  };
  const deployment = {
    schema: "triptych-browser-deployment-v1",
    twoMibProfiles: tuples.map(({ descriptor }) => descriptor),
    assets: tuples.flatMap(({ descriptor }) =>
      ["system", "bootstrap"].map((role) => ({
        path: descriptor[role].asset,
        bytes: descriptor[role].bytes,
        sha256: descriptor[role].sha256,
      })),
    ),
  };
  return { snapshot, deployment };
}
function historical(profile = "legacy-e400", length = 512, b = false) {
  return {
    bootstrap: { profile, bytes: new Uint8Array(256).fill(0x37) },
    drives: {
      A: { name: "../a.img", bytes: new Uint8Array(length).fill(0x98) },
      B: b
        ? { name: "../a.img", bytes: new Uint8Array(length).fill(0x98) }
        : null,
    },
  };
}
async function temporary(t) {
  const directory = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "triptych-native-archive-test-")),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
async function save(directory, snapshot) {
  const bytes = await encodeSavedMachine(snapshot);
  const archivePath = join(directory, "source.tds");
  await fs.writeFile(archivePath, bytes, { flag: "wx" });
  return { archivePath, bytes };
}

test("all sixteen real profiles preserve every disk and produce explicit native arguments", async (t) => {
  const root = await temporary(t);
  for (let count = 1; count <= 16; count++) {
    const directory = join(root, String(count));
    await fs.mkdir(directory);
    const { snapshot, deployment } = await twoMib(count);
    const { archivePath, bytes } = await save(directory, snapshot);
    const plan = await prepareNativeSavedMachine({
      archivePath,
      outputDirectory: join(directory, "session"),
      deployment,
    });
    assert.equal(plan.archiveSha256, hash(bytes));
    assert.equal(plan.profile, snapshot.bootstrap.profile);
    assert.equal(plan.configuredCount, count);
    assert.deepEqual(
      await fs.readFile(plan.retainedArchivePath),
      Buffer.from(bytes),
    );
    assert.deepEqual(await fs.readFile(archivePath), Buffer.from(bytes));
    assert.deepEqual(
      await fs.readFile(plan.bootstrap.path),
      snapshot.bootstrap.bytes,
    );
    assert.equal(plan.bootstrap.sha256, hash(snapshot.bootstrap.bytes));
    assert.deepEqual(plan.argv.slice(0, 4), [
      "--slots",
      String(count),
      "--image-bytes",
      "2097152",
    ]);
    assert.equal(plan.argv.at(-1), plan.bootstrap.path);
    const inodes = new Set();
    for (let index = 0; index < count; index++) {
      const disk = plan.slots[index];
      assert.equal(disk.instanceId, snapshot.slots[index].instanceId);
      assert.equal(disk.name, snapshot.slots[index].name);
      assert.equal(disk.byteLength, 2097152);
      assert.ok(isAbsolute(disk.path));
      assert.equal(
        disk.path,
        join(plan.outputDirectory, `drive-${disk.letter}.img`),
      );
      assert.deepEqual(plan.argv.slice(4 + index * 3, 7 + index * 3), [
        "--drive",
        disk.letter,
        disk.path,
      ]);
      assert.deepEqual(
        await fs.readFile(disk.path),
        Buffer.from(snapshot.slots[index].bytes),
      );
      const stat = await fs.stat(disk.path);
      inodes.add(`${stat.dev}:${stat.ino}`);
      assert.equal(stat.mode & 0o077, 0);
    }
    assert.equal(inodes.size, count);
    assert.equal((await fs.stat(plan.outputDirectory)).mode & 0o077, 0);
    assert.ok(isAbsolute(plan.archivePath));
  }
});

test("sparse A/P keeps fourteen configured empty slots and independent identical images", async (t) => {
  const root = await temporary(t);
  const { snapshot, deployment } = await twoMib(16);
  snapshot.slots.fill(null, 1, 15);
  const { archivePath } = await save(root, snapshot);
  const plan = await prepareNativeSavedMachine({
    archivePath,
    outputDirectory: join(root, "session"),
    deployment,
  });
  assert.deepEqual(plan.slots.slice(1, 15), Array(14).fill(null));
  assert.deepEqual(plan.argv, [
    "--slots",
    "16",
    "--image-bytes",
    "2097152",
    "--drive",
    "A",
    plan.slots[0].path,
    "--drive",
    "P",
    plan.slots[15].path,
    plan.bootstrap.path,
  ]);
  await fs.writeFile(plan.slots[15].path, Buffer.from("changed"));
  assert.deepEqual(
    await fs.readFile(plan.slots[0].path),
    Buffer.from(snapshot.slots[0].bytes),
  );
  assert.equal((await fs.readdir(plan.outputDirectory)).length, 4);
});

test("historical decoder domain and absent configured B survive without metadata", async (t) => {
  const root = await temporary(t);
  const cases = [
    historical(),
    historical("legacy-e400", 2097152),
    historical("triptych-cpu-v0.1-8m-a", 8388608),
    historical("triptych-cpu-v0.1-8m-ab", 8388608),
    historical("triptych-cpu-v0.1-8m-ab", 8388608, true),
  ];
  for (const [index, snapshot] of cases.entries()) {
    const directory = join(root, String(index));
    await fs.mkdir(directory);
    const { archivePath } = await save(directory, snapshot);
    const plan = await prepareNativeSavedMachine({
      archivePath,
      outputDirectory: join(directory, "session"),
    });
    assert.equal(plan.profile, snapshot.bootstrap.profile);
    assert.deepEqual(
      await fs.readFile(plan.bootstrap.path),
      Buffer.from(snapshot.bootstrap.bytes),
    );
    assert.deepEqual(
      await fs.readFile(plan.slots[0].path),
      Buffer.from(snapshot.drives.A.bytes),
    );
    assert.equal(
      plan.configuredCount,
      snapshot.bootstrap.profile.endsWith("-ab") ? 2 : 1,
    );
    if (plan.configuredCount === 2)
      assert.equal(plan.slots[1] === null, snapshot.drives.B === null);
    assert.equal(plan.argv[3], String(snapshot.drives.A.bytes.length));
    assert.equal("instanceId" in plan.slots[0], false);
  }
});

test("malformed archives and unavailable or mismatched admission create no output", async (t) => {
  const root = await temporary(t);
  const { snapshot, deployment } = await twoMib(4);
  const { archivePath, bytes } = await save(root, snapshot);
  const outputDirectory = join(root, "session");
  const unavailable = { ...deployment, twoMibProfiles: [] };
  for (const metadata of [undefined, unavailable]) {
    await assert.rejects(
      prepareNativeSavedMachine({
        archivePath,
        outputDirectory,
        deployment: metadata,
      }),
    );
    await assert.rejects(fs.lstat(outputDirectory), { code: "ENOENT" });
  }
  snapshot.bootstrap.bytes = snapshot.bootstrap.bytes.slice();
  snapshot.bootstrap.bytes[0] ^= 1;
  await fs.writeFile(archivePath, await encodeSavedMachine(snapshot));
  await assert.rejects(
    prepareNativeSavedMachine({ archivePath, outputDirectory, deployment }),
    { code: "SAVED_BOOTSTRAP_MISMATCH" },
  );
  await assert.rejects(fs.lstat(outputDirectory), { code: "ENOENT" });
  const corrupt = Buffer.from(bytes);
  corrupt[corrupt.length - 1] ^= 1;
  for (const malformed of [
    Buffer.from("TRPTYDS9"),
    corrupt,
    Buffer.from(bytes).subarray(0, 64),
  ]) {
    await fs.writeFile(archivePath, malformed);
    await assert.rejects(
      prepareNativeSavedMachine({ archivePath, outputDirectory, deployment }),
    );
    assert.deepEqual(await fs.readFile(archivePath), malformed);
    await assert.rejects(fs.lstat(outputDirectory), { code: "ENOENT" });
  }
});

test("source must be regular and output must be a new exclusive directory", async (t) => {
  const root = await temporary(t);
  const { archivePath, bytes } = await save(root, historical());
  for (const kind of ["file", "directory", "symlink", "dangling"]) {
    const outputDirectory = join(root, kind);
    if (kind === "file") await fs.writeFile(outputDirectory, "keep");
    else if (kind === "directory") await fs.mkdir(outputDirectory);
    else
      await fs.symlink(
        kind === "symlink" ? root : join(root, "missing"),
        outputDirectory,
      );
    const before = await fs.lstat(outputDirectory);
    await assert.rejects(
      prepareNativeSavedMachine({ archivePath, outputDirectory }),
      { code: "EEXIST" },
    );
    assert.equal((await fs.lstat(outputDirectory)).ino, before.ino);
    assert.deepEqual(await fs.readFile(archivePath), Buffer.from(bytes));
  }
  const link = join(root, "source-link");
  await fs.symlink(archivePath, link);
  for (const source of [root, link]) {
    await assert.rejects(
      prepareNativeSavedMachine({
        archivePath: source,
        outputDirectory: join(root, "absent"),
      }),
    );
    await assert.rejects(fs.lstat(join(root, "absent")), { code: "ENOENT" });
  }
});

test("partial file-write failure retains original archive and every created session file", async (t) => {
  const root = await temporary(t);
  const snapshot = historical("triptych-cpu-v0.1-8m-ab", 8388608, true);
  const { archivePath, bytes } = await save(root, snapshot);
  const outputDirectory = join(root, "session");
  const open = fs.open.bind(fs);
  // Inject only the failing write at the actual filesystem seam. Production has
  // no alternate publisher, generic filesystem interface or rollback path.
  t.mock.method(fs, "open", async (...args) => {
    const file = await open(...args);
    if (args[0] === join(outputDirectory, "drive-B.img")) {
      const write = file.writeFile.bind(file);
      t.mock.method(file, "writeFile", async (data) => {
        await write(data.subarray(0, 128));
        throw Object.assign(new Error("Injected full disk"), {
          code: "ENOSPC",
        });
      });
    }
    return file;
  });
  await assert.rejects(
    prepareNativeSavedMachine({ archivePath, outputDirectory }),
    (error) => {
      assert.equal(error.outputDirectory, outputDirectory);
      assert.equal(error.cause.code, "ENOSPC");
      return true;
    },
  );
  assert.deepEqual((await fs.readdir(outputDirectory)).sort(), [
    "bootstrap.bin",
    "drive-A.img",
    "drive-B.img",
    "original.tds",
  ]);
  assert.deepEqual(await fs.readFile(archivePath), Buffer.from(bytes));
  assert.deepEqual(
    await fs.readFile(join(outputDirectory, "original.tds")),
    Buffer.from(bytes),
  );
  assert.deepEqual(
    await fs.readFile(join(outputDirectory, "drive-A.img")),
    Buffer.from(snapshot.drives.A.bytes),
  );
  assert.deepEqual(
    await fs.readFile(join(outputDirectory, "drive-B.img")),
    Buffer.from(snapshot.drives.B.bytes.subarray(0, 128)),
  );
});

test("concurrent source mutation during capture rejects before creating output", async (t) => {
  const root = await temporary(t);
  const { archivePath } = await save(root, historical());
  const outputDirectory = join(root, "session");
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    const file = await open(...args);
    if (args[0] === archivePath) {
      const read = file.readFile.bind(file);
      t.mock.method(file, "readFile", async () => {
        const captured = await read();
        // An independent writer grows the opened source after the captured read.
        const writer = await open(archivePath, "a");
        try {
          await writer.writeFile(Uint8Array.of(42));
        } finally {
          await writer.close();
        }
        return captured;
      });
    }
    return file;
  });
  await assert.rejects(
    prepareNativeSavedMachine({ archivePath, outputDirectory }),
    /changed while it was being captured/,
  );
  await assert.rejects(fs.lstat(outputDirectory), { code: "ENOENT" });
});

test("optional metadata is loaded only for archives requiring two-MiB admission", async (t) => {
  const root = await temporary(t);
  const { archivePath } = await save(root, historical());
  await prepareNativeSavedMachine({
    archivePath,
    outputDirectory: join(root, "legacy-session"),
    loadDeployment: () => {
      throw new Error("Historical archives must not read optional metadata");
    },
  });
  const { snapshot, deployment } = await twoMib(2);
  await fs.writeFile(archivePath, await encodeSavedMachine(snapshot));
  let loads = 0;
  const outputDirectory = join(root, "two-mib-session");
  const plan = await prepareNativeSavedMachine({
    archivePath,
    outputDirectory,
    loadDeployment: async () => {
      loads++;
      await assert.rejects(fs.lstat(outputDirectory), { code: "ENOENT" });
      return deployment;
    },
  });
  assert.equal(loads, 1);
  assert.equal(plan.configuredCount, 2);
  const failedOutput = join(root, "failed-metadata");
  await assert.rejects(
    prepareNativeSavedMachine({
      archivePath,
      outputDirectory: failedOutput,
      loadDeployment: async () => {
        throw new Error("Malformed selected metadata");
      },
    }),
    /Malformed selected metadata/,
  );
  await assert.rejects(fs.lstat(failedOutput), { code: "ENOENT" });
});

test("file capture rejects oversized v4 and unknown headers before reading their payload", async (t) => {
  const root = await temporary(t);
  const archivePath = join(root, "oversized.tds");
  await fs.writeFile(archivePath, "TRPTYDS4");
  // A sparse invalid input makes the allocation boundary executable cheaply.
  await fs.truncate(archivePath, 33620237);
  const open = fs.open.bind(fs);
  let payloadReads = 0;
  t.mock.method(fs, "open", async (...args) => {
    const file = await open(...args);
    if (args[0] === archivePath) {
      t.mock.method(file, "readFile", async () => {
        payloadReads++;
        throw new Error("Unbounded payload read");
      });
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (...readArgs) => {
        if (readArgs[2] > 8) payloadReads++;
        return read(...readArgs);
      });
    }
    return file;
  });
  const highBit = Buffer.from("TRPTYDS3");
  highBit[0] |= 0x80;
  for (const header of [
    Buffer.from("TRPTYDS4"),
    Buffer.from("TRPTYDS9"),
    Buffer.from("NOTATDS!"),
    highBit,
  ]) {
    const writer = await open(archivePath, "r+");
    try {
      await writer.write(header, 0, header.length, 0);
    } finally {
      await writer.close();
    }
    await assert.rejects(
      prepareNativeSavedMachine({
        archivePath,
        outputDirectory: join(root, "session"),
      }),
    );
    assert.equal(payloadReads, 0);
    await assert.rejects(fs.lstat(join(root, "session")), { code: "ENOENT" });
  }
});

test("v4 capture bounds reads to the observed length and rejects concurrent growth", async (t) => {
  const root = await temporary(t);
  const archivePath = join(root, "growing.tds");
  const initial = Buffer.alloc(512);
  initial.write("TRPTYDS4");
  await fs.writeFile(archivePath, initial);
  const open = fs.open.bind(fs);
  let largestRead = 0;
  t.mock.method(fs, "open", async (...args) => {
    const file = await open(...args);
    if (args[0] === archivePath) {
      t.mock.method(file, "readFile", async () => {
        assert.fail("V4 capture must use bounded positional reads");
      });
      const read = file.read.bind(file);
      t.mock.method(file, "read", async (...readArgs) => {
        largestRead = Math.max(largestRead, readArgs[2]);
        const result = await read(...readArgs);
        if (readArgs[2] > 8) {
          const writer = await open(archivePath, "a");
          try {
            await writer.writeFile(Buffer.alloc(2048));
          } finally {
            await writer.close();
          }
        }
        return result;
      });
    }
    return file;
  });
  await assert.rejects(
    prepareNativeSavedMachine({
      archivePath,
      outputDirectory: join(root, "session"),
    }),
    /changed while it was being captured/,
  );
  assert.equal(largestRead, initial.length);
  assert.equal((await fs.stat(archivePath)).size, 2560);
  await assert.rejects(fs.lstat(join(root, "session")), { code: "ENOENT" });
});

test("short header reads preserve valid archives and reject truncated headers", async (t) => {
  const root = await temporary(t);
  const { archivePath, bytes } = await save(root, historical());
  const open = fs.open.bind(fs);
  t.mock.method(fs, "open", async (...args) => {
    const file = await open(...args);
    if (args[0] === archivePath) {
      const read = file.read.bind(file);
      t.mock.method(file, "read", (buffer, offset, length, position) =>
        read(buffer, offset, Math.min(length, 3), position),
      );
    }
    return file;
  });
  const plan = await prepareNativeSavedMachine({
    archivePath,
    outputDirectory: join(root, "session"),
  });
  assert.deepEqual(
    await fs.readFile(plan.retainedArchivePath),
    Buffer.from(bytes),
  );
  await fs.writeFile(archivePath, "TRPTYDS");
  await assert.rejects(
    prepareNativeSavedMachine({
      archivePath,
      outputDirectory: join(root, "truncated-session"),
    }),
    /invalid or unsupported archive header/,
  );
  await assert.rejects(fs.lstat(join(root, "truncated-session")), {
    code: "ENOENT",
  });
});
