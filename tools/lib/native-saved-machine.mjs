import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { decodeSavedMachineArchive } from "../../crates/triptych-host-wasm/web/saved-machine.js";
import { admitTwoMibSavedMachine } from "../../crates/triptych-host-wasm/web/two-mib-system.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const unchanged = (before, after) =>
  ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
    (key) => before[key] === after[key],
  );

async function captureArchive(path) {
  // Do not follow a replaced leaf or block opening a FIFO. The handle, rather
  // than a prior pathname check, establishes what bytes are being captured.
  const file = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat({ bigint: true });
    if (!before.isFile())
      throw new Error("Saved archive must be a regular file.");
    const header = Buffer.alloc(8);
    let headerLength = 0;
    while (headerLength < header.length) {
      const { bytesRead } = await file.read(
        header,
        headerLength,
        header.length - headerLength,
        headerLength,
      );
      if (bytesRead === 0) break;
      headerLength += bytesRead;
    }
    const version = header.toString("latin1");
    if (
      headerLength !== header.length ||
      !["TRPTYDS3", "TRPTYDS4"].includes(version)
    )
      throw new Error("Saved machine: invalid or unsupported archive header.");
    let bytes;
    if (version === "TRPTYDS4") {
      // The v4 wire contract caps the complete archive at 33,620,236 bytes.
      // Read only the observed length, even if another writer grows the file.
      // Historical readers keep their existing accepted size domain.
      if (before.size > 33620236n)
        throw new Error("Saved machine: archive exceeds maximum length.");
      bytes = Buffer.alloc(Number(before.size));
      let position = 0;
      while (position < bytes.length) {
        const { bytesRead } = await file.read(
          bytes,
          position,
          bytes.length - position,
          position,
        );
        if (bytesRead === 0)
          throw new Error("Saved archive changed while it was being captured.");
        position += bytesRead;
      }
    } else bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    const named = await fs.lstat(path, { bigint: true });
    if (
      !named.isFile() ||
      !unchanged(before, after) ||
      !unchanged(after, named) ||
      BigInt(bytes.length) !== after.size
    )
      throw new Error("Saved archive changed while it was being captured.");
    return bytes;
  } finally {
    await file.close();
  }
}

async function writeNewFile(path, bytes) {
  const file = await fs.open(path, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Materialize a private native session from one exact saved authority.
 * Admission checks selected metadata consistency and the saved bootstrap hash;
 * it does not authenticate a release or verify all files in a deployment.
 * Saved resident bytes are never downloaded or replaced.
 *
 * This prepares files only. Session disks may contain writes made before a
 * guest flush, so neither success nor process exit authorizes repacking them as
 * saved checkpoints. The original archive and partial output survive failures.
 */
export async function prepareNativeSavedMachine({
  archivePath,
  outputDirectory,
  deployment,
  loadDeployment,
}) {
  if (typeof archivePath !== "string" || !archivePath)
    throw new Error("An archive path is required.");
  if (typeof outputDirectory !== "string" || !outputDirectory)
    throw new Error("A new session directory is required.");
  if (
    loadDeployment !== undefined &&
    (typeof loadDeployment !== "function" || deployment !== undefined)
  )
    throw new Error(
      "Select either deployment metadata or one metadata loader.",
    );
  const requestedSource = resolve(archivePath);
  const source = join(
    await fs.realpath(dirname(requestedSource)),
    basename(requestedSource),
  );
  const bytes = await captureArchive(source);
  let snapshot = await decodeSavedMachineArchive(bytes, webcrypto);
  if (snapshot.schema === "triptych-drive-set-v4") {
    const selectedDeployment = loadDeployment
      ? await loadDeployment()
      : deployment;
    const admission = await admitTwoMibSavedMachine({
      snapshot,
      deployment: selectedDeployment,
      crypto: webcrypto,
    });
    if (admission.status !== "admitted")
      throw Object.assign(new Error(admission.reason), {
        code: admission.code,
      });
    snapshot = admission.snapshot;
  }

  // Resolve existing parents only; mkdir without recursive accepts exactly one
  // new directory and rejects existing files, directories and dangling links.
  const requested = resolve(outputDirectory);
  const directory = join(
    await fs.realpath(dirname(requested)),
    basename(requested),
  );
  await fs.mkdir(directory, { mode: 0o700 });
  const retainedArchivePath = join(directory, "original.tds");
  try {
    await writeNewFile(retainedArchivePath, bytes);
    const bootstrapPath = join(directory, "bootstrap.bin");
    await writeNewFile(bootstrapPath, snapshot.bootstrap.bytes);
    const twoMib = snapshot.schema === "triptych-drive-set-v4";
    const media = twoMib
      ? snapshot.slots
      : snapshot.bootstrap.profile === "triptych-cpu-v0.1-8m-ab"
        ? [snapshot.drives.A, snapshot.drives.B]
        : [snapshot.drives.A];
    const slots = [];
    const imageBytes = twoMib ? 2097152 : snapshot.drives.A.bytes.length;
    const argv = [
      "--slots",
      String(media.length),
      "--image-bytes",
      String(imageBytes),
    ];
    for (const [index, disk] of media.entries()) {
      if (disk === null) {
        slots.push(null);
        continue;
      }
      const letter = String.fromCharCode(65 + index);
      // Saved names are descriptive metadata only, never pathname components.
      const path = join(directory, `drive-${letter}.img`);
      await writeNewFile(path, disk.bytes);
      slots.push({
        letter,
        path,
        name: disk.name,
        ...(twoMib ? { instanceId: disk.instanceId } : {}),
        byteLength: disk.bytes.length,
      });
      argv.push("--drive", letter, path);
    }
    argv.push(bootstrapPath);
    return {
      archivePath: source,
      archiveSha256: sha256(bytes),
      retainedArchivePath,
      outputDirectory: directory,
      profile: snapshot.bootstrap.profile,
      configuredCount: media.length,
      bootstrap: {
        path: bootstrapPath,
        byteLength: snapshot.bootstrap.bytes.length,
        sha256: sha256(snapshot.bootstrap.bytes),
      },
      slots,
      argv,
    };
  } catch (cause) {
    throw Object.assign(
      new Error(
        `Native session preparation failed; partial files remain in ${directory}.`,
        { cause },
      ),
      { outputDirectory: directory, retainedArchivePath },
    );
  }
}
