import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildCpmDistribution } from "../../tools/lib/cpm-distribution.mjs";
import { readCpm22File } from "../../tools/lib/cpm22-disk.mjs";

const root = resolve(import.meta.dirname, "../..");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

describe("pinned fresh CP/M distribution", () => {
  it("builds identical private images with exact released files and slots", async () => {
    const first = await buildCpmDistribution(root, { allowDirty: true });
    const second = await buildCpmDistribution(root, { allowDirty: true });
    expect(first).toEqual(second);
    expect(first.disk.buffer).not.toBe(second.disk.buffer);
    expect(first.disk).toHaveLength(256512);
    expect(sha(first.disk)).toBe(first.manifest.disk.sha256);
    expect(first.manifest.triptych.revision).toMatch(/^[0-9a-f]{40}$/);
    for (const entry of first.manifest.components.slice(0, 6)) {
      const bytes =
        entry.install.kind === "file"
          ? readCpm22File(first.disk, entry.install.name).slice(0, entry.bytes)
          : first.disk.slice(
              entry.install.firstRecord * 128,
              entry.install.firstRecord * 128 + entry.bytes,
            );
      expect(sha(bytes)).toBe(entry.sha256);
    }
    expect(first.disk.slice(256256)).toEqual(new Uint8Array(256));
    expect(
      Buffer.from(readCpm22File(first.disk, "INPUT.NU")).toString("ascii"),
    ).toContain("sub main() fails\r\n");
  });

  it.each(["repository", "resolved"])(
    "rejects forged ATOM %s before loading artifacts",
    async (field) => {
      const directory = await mkdtemp(
        join(tmpdir(), "triptych-lock-regression-"),
      );
      try {
        await mkdir(join(directory, "distribution"));
        const lock = JSON.parse(
          await readFile(join(root, "distribution/components.lock.json")),
        );
        const pkg = JSON.parse(await readFile(join(root, "package.json")));
        const npm = JSON.parse(await readFile(join(root, "package-lock.json")));
        const fake = "https://example.com/not-the-installed-atom.git";
        if (field === "repository") {
          lock.atom.repository = fake;
          lock.components.find((c) => c.id === "atom").source.repository = fake;
          pkg.devDependencies["atom-z80"] = `git+${fake}#${lock.atom.revision}`;
          npm.packages[""].devDependencies["atom-z80"] =
            pkg.devDependencies["atom-z80"];
        } else {
          npm.packages["node_modules/atom-z80"].resolved =
            `git+${fake}#${lock.atom.revision}`;
        }
        await Promise.all([
          writeFile(
            join(directory, "distribution/components.lock.json"),
            JSON.stringify(lock),
          ),
          writeFile(join(directory, "package.json"), JSON.stringify(pkg)),
          writeFile(join(directory, "package-lock.json"), JSON.stringify(npm)),
        ]);
        await expect(
          buildCpmDistribution(directory, { allowDirty: true }),
        ).rejects.toThrow(
          field === "repository"
            ? "ATOM repository"
            : "installed ATOM lock identity",
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
