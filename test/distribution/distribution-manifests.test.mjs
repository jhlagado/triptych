import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { validateDistributionManifest } from "../../tools/lib/distribution-manifests.mjs";

const root = resolve(import.meta.dirname, "../..");
const atomRevision = "802b5c2d320bec777f427755ff2d7338e3b80a05";
const manifests = Object.fromEntries(
  await Promise.all(
    [
      ["os", "portable-cpm/manifest.json"],
      ["nucleus", "nucleus/NUC.manifest.json"],
      ["edit", "edit/manifest.json"],
    ].map(async ([id, path]) => [
      id,
      JSON.parse(await readFile(resolve(root, "third_party", path), "utf8")),
    ]),
  ),
);

function fixture(id) {
  const resident = id === "ccp" || id === "bdos";
  const manifest = structuredClone(manifests[resident ? "os" : id]);
  const entry = resident
    ? manifest.components.find((entry) => entry.id === id)
    : manifest;
  const component = {
    id,
    recipe: "verified-release",
    role: resident ? "resident" : "application",
    source: {
      kind: "git",
      repository: `https://github.com/jhlagado/${resident ? "portable-cpm" : id}.git`,
      revision: "a".repeat(40),
      path: resident
        ? `src/${id}.asm`
        : id === "nucleus"
          ? "asm/vertical-slice/cpm22-native-compiler.asm"
          : "src/editor.asm",
    },
    artifact: { bytes: entry.bytes, sha256: entry.sha256 },
    target: resident
      ? {
          origin: id === "ccp" ? 0xe400 : 0xec00,
          capacity: id === "ccp" ? 2048 : 3584,
        }
      : { origin: 256, capacity: 0xe300 },
    install: resident
      ? {
          kind: "system-records",
          firstRecord: id === "ccp" ? 0 : 16,
          recordCount: id === "ccp" ? 16 : 28,
        }
      : {
          kind: "file",
          name: id === "nucleus" ? "NUC.COM" : "EDIT.COM",
          padByte: 26,
        },
  };
  return { component, manifest, entry };
}

describe("distribution manifest target checks", () => {
  it.each(["ccp", "bdos", "nucleus", "edit"])(
    "accepts published %s metadata without mutation",
    (id) => {
      const f = fixture(id);
      const before = structuredClone(f);
      expect(
        validateDistributionManifest(f.component, f.manifest, atomRevision),
      ).toEqual(f.manifest);
      expect(f).toEqual(before);
    },
  );

  it.each(["ccp", "bdos", "nucleus", "edit"])(
    "rejects tampered %s lock identity and placement",
    (id) => {
      for (const mutate of [
        (c) => {
          c.recipe = "atom-binary";
        },
        (c) => {
          c.source.kind = "triptych";
        },
        (c) => {
          c.source.repository = "https://example.com/other.git";
        },
        (c) => {
          c.source.path = "other.asm";
        },
        (c) => {
          c.target.origin++;
        },
        (c) => {
          c.target.capacity = 0xe301;
        },
        (c) => {
          c.install.kind = "other";
        },
        (c) => {
          c.artifact.bytes++;
        },
        (c) => {
          c.artifact.sha256 = "0".repeat(64);
        },
        (c) => {
          c.role = "other";
        },
      ]) {
        const f = fixture(id);
        mutate(f.component);
        const before = structuredClone(f);
        expect(() =>
          validateDistributionManifest(f.component, f.manifest, atomRevision),
        ).toThrow();
        expect(f).toEqual(before);
      }
    },
  );

  it.each(["ccp", "bdos"])("rejects wrong %s manifest semantics", (id) => {
    for (const mutate of [
      (f) => {
        f.manifest.schema = "wrong";
      },
      (f) => {
        f.manifest.targetProfile = "other";
      },
      (f) => {
        f.manifest.atom.repository = "https://example.com/atom";
      },
      (f) => {
        f.manifest.atom.revision = "b".repeat(40);
      },
      (f) => {
        f.entry.source = "other.asm";
      },
      (f) => {
        f.entry.file = "other.bin";
      },
      (f) => {
        f.entry.origin++;
      },
      (f) => {
        f.entry.entry++;
      },
      (f) => {
        f.entry.capacity--;
      },
      (f) => {
        f.entry.bytes--;
      },
      (f) => {
        f.entry.sha256 = "0".repeat(64);
      },
      (f) => {
        f.component.install.firstRecord++;
      },
      (f) => {
        f.component.install.recordCount--;
      },
      (f) => {
        f.manifest.components = [];
      },
      (f) => {
        f.manifest.components.push(structuredClone(f.entry));
      },
      (f) => {
        const other = f.manifest.components.find((e) => e.id !== id);
        f.manifest.components.push(structuredClone(other));
      },
    ]) {
      const f = fixture(id);
      mutate(f);
      expect(() =>
        validateDistributionManifest(f.component, f.manifest, atomRevision),
      ).toThrow();
    }
  });

  it.each(["nucleus", "edit"])(
    "rejects wrong %s application metadata",
    (id) => {
      for (const mutate of [
        (f) => {
          f.manifest.format = "wrong";
        },
        (f) => {
          f.manifest.artifact = "OTHER.COM";
        },
        (f) => {
          f.manifest.loadAddress++;
        },
        (f) => {
          f.manifest.entryAddress++;
        },
        (f) => {
          f.manifest.bytes++;
        },
        (f) => {
          f.manifest.sha256 = "0".repeat(64);
        },
        (f) => {
          f.manifest.assembler.name = "other";
        },
        (f) => {
          f.manifest.assembler.revision = "b".repeat(40);
        },
        (f) => {
          f.component.install.name = "OTHER.COM";
        },
        (f) => {
          f.component.install.padByte = 0;
        },
        (f) => {
          f.component.target.capacity = f.component.artifact.bytes - 1;
        },
      ]) {
        const f = fixture(id);
        mutate(f);
        expect(() =>
          validateDistributionManifest(f.component, f.manifest, atomRevision),
        ).toThrow();
      }
    },
  );

  it("binds Nucleus source and end address", () => {
    for (const field of ["source", "endAddress"]) {
      const f = fixture("nucleus");
      f.manifest[field] = "wrong";
      expect(() =>
        validateDistributionManifest(f.component, f.manifest, atomRevision),
      ).toThrow();
    }
  });

  it("rejects unsupported component identities", () => {
    const f = fixture("edit");
    f.component.id = "other";
    expect(() =>
      validateDistributionManifest(f.component, f.manifest, atomRevision),
    ).toThrow(/unsupported/);
  });
});
