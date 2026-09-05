import { describe, expect, it } from "vitest";

import {
  COMPONENT_LOCK_SCHEMA,
  validateComponentLock,
} from "../../tools/lib/component-lock.mjs";

const revision = "1".repeat(40);
const digest = "2".repeat(64);
const trusted = new Set([
  "atom-binary",
  "edit-package",
  "verified-prebuilt",
  "verified-release",
]);

function fixture() {
  return {
    schema: COMPONENT_LOCK_SCHEMA,
    targetProfile: "triptych-cpu-v0.1",
    disk: { bytes: 256256, recordBytes: 128, systemRecords: 52 },
    atom: {
      repository: "https://github.com/jhlagado/atom.git",
      revision,
      package: "atom-z80",
      seed: { bytes: 12400, sha256: digest },
    },
    components: [
      {
        id: "ccp",
        role: "resident",
        source: {
          kind: "git",
          repository: "https://example.test/free-cpm.git",
          revision,
          path: "src/ccp.asm",
        },
        recipe: "atom-binary",
        target: { origin: 0xe400, capacity: 0x0800 },
        install: { kind: "system-records", firstRecord: 0, recordCount: 16 },
        licence: { spdx: "GPL-3.0-or-later", provenance: "LICENSE" },
      },
      {
        id: "bios",
        role: "resident",
        source: { kind: "triptych", path: "system/cpm/bios.asm" },
        recipe: "atom-binary",
        target: { origin: 0xfa00, capacity: 0x0400 },
        install: { kind: "system-records", firstRecord: 44, recordCount: 8 },
        licence: { spdx: "GPL-3.0-or-later", provenance: "LICENSE" },
      },
      {
        id: "edit",
        role: "application",
        source: {
          kind: "git",
          repository: "https://github.com/jhlagado/edit.git",
          revision: "ac59b478b686b7cd1a3a340064e82d64fdc58589",
          path: "package.json",
        },
        recipe: "edit-package",
        target: { origin: 0x0100, capacity: 0xd000 },
        install: { kind: "file", name: "EDIT.COM", padByte: 0x1a },
        licence: {
          spdx: "GPL-3.0-or-later",
          provenance: "LICENSE",
        },
      },
    ],
  };
}

function releasedFixture() {
  const lock = fixture();
  lock.components[2].recipe = "verified-release";
  lock.components[2].artifact = {
    path: "third_party/edit/EDIT.COM",
    bytes: 3003,
    sha256: digest,
    manifest: "third_party/edit/manifest.json",
    provenance: "third_party/edit/PROVENANCE.json",
  };
  return lock;
}

function historicalSource() {
  return {
    kind: "prebuilt",
    path: "third_party/historical/EDIT.COM",
    bytes: 3003,
    sha256: digest,
    provenance: "third_party/historical/PROVENANCE.md",
  };
}

describe("Triptych component lock", () => {
  it("accepts immutable external sources and Triptych-owned BIOS source", () => {
    expect(validateComponentLock(fixture(), { recipes: trusted })).toEqual(
      fixture(),
    );
  });

  it("requires the caller's trusted recipe registry", () => {
    expect(() => validateComponentLock(fixture())).toThrow(/trusted recipe/);
  });

  it("associates released bytes with an immutable Git source", () => {
    const lock = releasedFixture();
    expect(validateComponentLock(lock, { recipes: trusted })).toEqual(lock);
  });

  it("retains historical prebuilts without a fabricated Git identity", () => {
    const lock = fixture();
    lock.components[2].source = historicalSource();
    lock.components[2].recipe = "verified-prebuilt";
    expect(validateComponentLock(lock, { recipes: trusted })).toEqual(lock);
  });

  it("requires verified-release to be registered by local tooling", () => {
    const recipes = new Set(trusted);
    recipes.delete("verified-release");
    expect(() => validateComponentLock(releasedFixture(), { recipes })).toThrow(
      /recipe is not trusted/,
    );
  });

  it.each([
    ["missing artifact", (component) => delete component.artifact, /artifact/],
    [
      "Triptych source",
      (component) =>
        (component.source = { kind: "triptych", path: "tools/edit.asm" }),
      /source.kind/,
    ],
    [
      "historical prebuilt source",
      (component) => (component.source = historicalSource()),
      /recipe/,
    ],
    [
      "source-build recipe",
      (component) => (component.recipe = "edit-package"),
      /artifact requires/,
    ],
    [
      "historical prebuilt recipe",
      (component) => {
        component.source = historicalSource();
        component.recipe = "verified-prebuilt";
      },
      /artifact requires/,
    ],
    [
      "unknown artifact field",
      (component) => (component.artifact.command = "npm run build"),
      /unknown field command/,
    ],
    [
      "missing digest",
      (component) => delete component.artifact.sha256,
      /missing sha256/,
    ],
    [
      "malformed digest",
      (component) => (component.artifact.sha256 = "f".repeat(63)),
      /sha256/,
    ],
    [
      "empty artifact",
      (component) => (component.artifact.bytes = 0),
      /bytes must be positive/,
    ],
    [
      "fractional byte count",
      (component) => (component.artifact.bytes = 1.5),
      /bytes must be a non-negative safe integer/,
    ],
    [
      "artifact beyond target capacity",
      (component) => (component.artifact.bytes = component.target.capacity + 1),
      /artifact exceeds target capacity/,
    ],
  ])("rejects released input with %s", (_description, mutate, diagnostic) => {
    const lock = releasedFixture();
    mutate(lock.components[2]);
    expect(() => validateComponentLock(lock, { recipes: trusted })).toThrow(
      diagnostic,
    );
  });

  it.each(["path", "manifest", "provenance"])(
    "requires a normalized local artifact %s",
    (field) => {
      for (const invalid of [
        "../outside",
        "third_party/../../outside",
        "/outside",
        "C:/outside",
        "C:outside",
        "third_party\\outside",
        "third_party//outside",
        "third_party/./outside",
        "third_party/invalid\0path",
        "",
      ]) {
        const lock = releasedFixture();
        lock.components[2].artifact[field] = invalid;
        expect(() => validateComponentLock(lock, { recipes: trusted })).toThrow(
          `artifact.${field}`,
        );
      }
    },
  );

  it.each([
    [
      "a branch in place of a revision",
      (lock) => (lock.components[0].source.revision = "main"),
    ],
    [
      "an arbitrary build recipe",
      (lock) => (lock.components[0].recipe = "run-shell"),
    ],
    [
      "a source path traversal",
      (lock) => (lock.components[0].source.path = "../ccp.asm"),
    ],
    [
      "an overlapping system range",
      (lock) => (lock.components[1].install.firstRecord = 15),
    ],
    [
      "an overlapping resident memory range",
      (lock) => (lock.components[1].target.origin = 0xebff),
    ],
    [
      "a duplicate disk filename",
      (lock) =>
        lock.components.push({ ...lock.components[2], id: "edit-copy" }),
    ],
    [
      "a resident installed as a file",
      (lock) =>
        (lock.components[0].install = {
          kind: "file",
          name: "CCP.COM",
          padByte: 0x1a,
        }),
    ],
    [
      "a Git source with the prebuilt recipe",
      (lock) => (lock.components[2].recipe = "verified-prebuilt"),
    ],
    [
      "a target beyond 64 KiB",
      (lock) => (lock.components[1].target.capacity = 0x0601),
    ],
    [
      "a resident slot whose disk size differs",
      (lock) => (lock.components[1].install.recordCount = 7),
    ],
    [
      "system records beyond the disk geometry",
      (lock) => (lock.disk.systemRecords = 51),
    ],
    [
      "an unknown field",
      (lock) => (lock.components[0].command = "npm run build"),
    ],
  ])("rejects %s", (_description, mutate) => {
    const lock = fixture();
    mutate(lock);
    expect(() => validateComponentLock(lock, { recipes: trusted })).toThrow();
  });
});
