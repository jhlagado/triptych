import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EDIT_BYTES,
  EDIT_SHA256,
  readVerifiedEditRelease,
} from "../../tools/lib/edit-release.mjs";
import { readCpm22File } from "../../tools/lib/cpm22-disk.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("standalone Edit release", () => {
  it("verifies the pinned release asset and the program in the base disk", async () => {
    const release = await readVerifiedEditRelease(repositoryRoot);
    const disk = new Uint8Array(
      await readFile(resolve(repositoryRoot, "third_party/cpm22/cpm22.img")),
    );
    const installed = readCpm22File(disk, "EDIT.COM");

    expect(release).toHaveLength(EDIT_BYTES);
    expect(sha256(release)).toBe(EDIT_SHA256);
    expect(installed.slice(0, EDIT_BYTES)).toEqual(release);
    expect([...installed.slice(EDIT_BYTES)]).toEqual(
      Array(installed.length - EDIT_BYTES).fill(0x1a),
    );
  });
});
