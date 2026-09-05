import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { validateComponentLock } from "../../tools/lib/component-lock.mjs";
import {
  readVerifiedRelease,
  RELEASE_PROVENANCE_SCHEMA,
} from "../../tools/lib/verified-release.mjs";

const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "triptych-release-proof-"));
  temporary.push(directory);
  const root = join(directory, "repository");
  await mkdir(join(root, "inputs"), { recursive: true });
  const bytes = Uint8Array.of(0x3e, 42, 0xc9);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const repository = "https://example.com/editor.git";
  const revision = "a".repeat(40);
  const component = validateComponentLock(
    {
      schema: "triptych-component-lock-v1",
      targetProfile: "triptych-cpu-v0.1",
      disk: { bytes: 256256, recordBytes: 128, systemRecords: 52 },
      atom: {
        repository: "https://example.com/atom.git",
        revision,
        package: "atom-z80",
        seed: { bytes: 1, sha256: "b".repeat(64) },
      },
      components: [
        {
          id: "editor",
          role: "application",
          recipe: "verified-release",
          source: { kind: "git", repository, revision, path: "src/editor.asm" },
          artifact: {
            path: "inputs/EDIT.COM",
            bytes: bytes.length,
            sha256,
            manifest: "inputs/manifest.json",
            provenance: "inputs/provenance.json",
          },
          target: { origin: 256, capacity: 8192 },
          install: { kind: "file", name: "EDIT.COM", padByte: 26 },
          licence: {
            spdx: "GPL-3.0-or-later",
            provenance: "inputs/provenance.json",
          },
        },
      ],
    },
    { recipes: new Set(["verified-release"]) },
  ).components[0];
  const manifest = {
    upstreamFormat: "example-v2",
    products: [{ filename: "EDIT.COM" }],
  };
  const provenance = {
    schema: RELEASE_PROVENANCE_SCHEMA,
    repository,
    revision,
    bytes: bytes.length,
    sha256,
    manifestSha256: createHash("sha256")
      .update(JSON.stringify(manifest))
      .digest("hex"),
    origin: {
      kind: "release-asset",
      url: "https://example.com/editor/releases/download/v1/EDIT.COM",
    },
  };
  const writeJson = (field, value) =>
    writeFile(join(root, component.artifact[field]), JSON.stringify(value));
  await Promise.all([
    writeFile(join(root, component.artifact.path), bytes),
    writeJson("manifest", manifest),
    writeJson("provenance", provenance),
  ]);
  return { directory, root, component, bytes, manifest, provenance, writeJson };
}

describe("reviewed release input verification", () => {
  it.each(["release-asset", "ci-artifact"])(
    "accepts verified %s bytes without interpreting the upstream manifest",
    async (kind) => {
      const f = await fixture();
      f.provenance.origin.kind = kind;
      await f.writeJson("provenance", f.provenance);
      const result = await readVerifiedRelease(f.root, f.component);
      expect(result).toEqual({ bytes: f.bytes, manifest: f.manifest });
      result.bytes.fill(0);
      expect((await readVerifiedRelease(f.root, f.component)).bytes).toEqual(
        f.bytes,
      );
    },
  );

  it.each([Uint8Array.of(0), Uint8Array.of(0x3e, 41, 0xc9)])(
    "rejects changed artifact bytes %#",
    async (bytes) => {
      const f = await fixture();
      await writeFile(join(f.root, f.component.artifact.path), bytes);
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
        /release artifact/,
      );
    },
  );

  it.each([
    ["schema", "unknown"],
    ["repository", "https://example.com/other.git"],
    ["revision", "b".repeat(40)],
    ["bytes", 4],
    ["sha256", "0".repeat(64)],
    ["manifestSha256", "0".repeat(64)],
    ["manifestSha256", "invalid"],
    ["extra", true],
    ["origin", { kind: "tag", url: "https://example.com/tag" }],
    ["origin", { kind: "release-asset", url: "file:///tmp/asset" }],
    [
      "origin",
      { kind: "ci-artifact", url: "https://user:secret@example.com/asset" },
    ],
    ["origin", { kind: "ci-artifact", url: "not a URL" }],
    [
      "origin",
      { kind: "ci-artifact", url: "https://example.com/asset", extra: 1 },
    ],
  ])(
    "rejects provenance mismatch or invalid field %s %#",
    async (field, value) => {
      const f = await fixture();
      f.provenance[field] = value;
      await f.writeJson("provenance", f.provenance);
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow();
    },
  );

  it.each([
    "schema",
    "repository",
    "revision",
    "bytes",
    "sha256",
    "manifestSha256",
    "origin",
  ])("requires provenance %s", async (field) => {
    const f = await fixture();
    delete f.provenance[field];
    await f.writeJson("provenance", f.provenance);
    await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
      /missing/,
    );
  });

  it.each(["kind", "url"])("requires provenance origin %s", async (field) => {
    const f = await fixture();
    delete f.provenance.origin[field];
    await f.writeJson("provenance", f.provenance);
    await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
      /missing/,
    );
  });

  it.each(["path", "manifest", "provenance"])(
    "rejects traversal and symlink escapes for %s",
    async (field) => {
      const f = await fixture();
      const original = f.component.artifact[field];
      for (const path of [
        "../outside",
        "/tmp/outside",
        "inputs/../outside",
        "inputs//outside",
        "C:/outside",
        "inputs\\outside",
        "inputs/./outside",
        "inputs/\0outside",
      ]) {
        f.component.artifact[field] = path;
        await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
          /normalized relative path/,
        );
      }
      const outside = join(f.directory, "repository-other");
      await mkdir(outside);
      await writeFile(join(outside, "asset"), f.bytes);
      await symlink(outside, join(f.root, "escape"));
      f.component.artifact[field] = "escape/asset";
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
        /outside the repository/,
      );
      f.component.artifact[field] = original;
      await rm(join(f.root, original));
      await symlink(join(outside, "asset"), join(f.root, original));
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
        /outside the repository/,
      );
    },
  );

  it("accepts an internal symlink and a symlinked repository root", async () => {
    const f = await fixture();
    await symlink(join(f.root, "inputs"), join(f.root, "alias"));
    await symlink(f.root, join(f.directory, "root-alias"));
    f.component.artifact.path = "alias/EDIT.COM";
    expect(
      (await readVerifiedRelease(join(f.directory, "root-alias"), f.component))
        .bytes,
    ).toEqual(f.bytes);
  });

  it.each(["path", "manifest", "provenance"])(
    "rejects missing files for %s",
    async (field) => {
      const f = await fixture();
      await rm(join(f.root, f.component.artifact[field]));
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow();
    },
  );

  it.each(["manifest", "provenance"])(
    "rejects malformed JSON in %s",
    async (field) => {
      const f = await fixture();
      await writeFile(join(f.root, f.component.artifact[field]), "{");
      if (field === "manifest") {
        f.provenance.manifestSha256 = createHash("sha256")
          .update("{")
          .digest("hex");
        await f.writeJson("provenance", f.provenance);
      }
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
        SyntaxError,
      );
    },
  );

  it.each(["path", "manifest", "provenance"])(
    "rejects directories for %s",
    async (field) => {
      const f = await fixture();
      f.component.artifact[field] = "inputs";
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
        /regular file/,
      );
    },
  );

  it.each([null, [], "text"])(
    "rejects non-object provenance %#",
    async (provenance) => {
      const f = await fixture();
      await f.writeJson("provenance", provenance);
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
        /must be an object/,
      );
    },
  );

  it.each([null, [], "text"])(
    "rejects a non-object manifest %#",
    async (manifest) => {
      const f = await fixture();
      await f.writeJson("manifest", manifest);
      f.provenance.manifestSha256 = createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex");
      await f.writeJson("provenance", f.provenance);
      await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
        /JSON object/,
      );
    },
  );

  it("rejects changed manifest bytes before interpreting their contents", async () => {
    const f = await fixture();
    await f.writeJson("manifest", { upstreamFormat: "changed", target: 0 });
    await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
      /manifest SHA-256/,
    );
    await writeFile(join(f.root, f.component.artifact.manifest), "{");
    await expect(readVerifiedRelease(f.root, f.component)).rejects.toThrow(
      /manifest SHA-256/,
    );
  });
});
