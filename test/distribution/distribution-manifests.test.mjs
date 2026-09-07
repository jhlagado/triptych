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
      ["caverns80", "caverns80/manifest.json"],
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
          : id === "caverns80"
            ? "src/main.asm"
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
          name:
            id === "nucleus"
              ? "NUC.COM"
              : id === "caverns80"
                ? "CAVERNS.COM"
                : "EDIT.COM",
          padByte: 26,
        },
  };
  return { component, manifest, entry };
}

describe("distribution manifest target checks", () => {
  it.each(["ccp", "bdos"])(
    "requires explicit matching A/B profile for %s",
    (id) => {
      const f = fixture(id);
      f.component.target.origin -= 256;
      f.entry.origin -= 256;
      f.entry.entry -= 256;
      f.manifest.targetProfile = "triptych-cpu-v0.1-8m-ab";
      expect(() =>
        validateDistributionManifest(f.component, f.manifest, atomRevision),
      ).toThrow();
      expect(
        validateDistributionManifest(
          f.component,
          f.manifest,
          atomRevision,
          "triptych-cpu-v0.1-8m-ab",
        ),
      ).toEqual(f.manifest);
      for (const mutate of [
        (x) => {
          x.manifest.targetProfile = "triptych-cpu-v0.1";
        },
        (x) => {
          x.entry.origin += 256;
        },
        (x) => {
          x.entry.entry += 256;
        },
        (x) => {
          x.component.target.origin += 256;
        },
      ]) {
        const bad = structuredClone(f);
        bad.entry = bad.manifest.components.find((entry) => entry.id === id);
        mutate(bad);
        expect(() =>
          validateDistributionManifest(
            bad.component,
            bad.manifest,
            atomRevision,
            "triptych-cpu-v0.1-8m-ab",
          ),
        ).toThrow();
      }
      expect(() =>
        validateDistributionManifest(
          f.component,
          f.manifest,
          atomRevision,
          "test-multi-drive-workspace-v1",
        ),
      ).toThrow(/unsupported/);
    },
  );

  it("bounds A/B application loading independently of runtime workspace", () => {
    const f = fixture("nucleus");
    expect(() =>
      validateDistributionManifest(
        f.component,
        f.manifest,
        atomRevision,
        "triptych-cpu-v0.1-8m-ab",
      ),
    ).toThrow(/capacity/);
    f.component.target.capacity = 0xe200;
    expect(
      validateDistributionManifest(
        f.component,
        f.manifest,
        atomRevision,
        "triptych-cpu-v0.1-8m-ab",
      ),
    ).toEqual(f.manifest);
  });

  it.each(["ccp", "bdos", "nucleus", "edit", "caverns80"])(
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

  it.each(["ccp", "bdos", "nucleus", "edit", "caverns80"])(
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

  it.each(["nucleus", "edit", "caverns80"])(
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

  it("requires Caverns native source and complete bounded static memory", () => {
    const mutations = [
      (m) => {
        m.sourceFormat = "legacy";
      },
      (m) => {
        delete m.memory;
      },
      (m) => {
        m.memory.start++;
      },
      (m) => {
        m.memory.endExclusive++;
      },
      (m) => {
        m.memory.allocatedBytes--;
      },
      (m) => {
        m.memory.dynamicAllocationBytes = 1;
      },
      (m) => {
        m.memory.stackStart = 0;
      },
      (m) => {
        m.memory.stackEndExclusive = m.memory.endExclusive + 1;
      },
      (m) => {
        m.memory.stackBytes = 0;
      },
      (m) => {
        m.memory.stackBytes++;
      },
      (m) => {
        m.memory.stackStart = 1.5;
      },
      (m) => {
        m.memory.endExclusive = Number.MAX_SAFE_INTEGER + 1;
      },
    ];
    for (const mutate of mutations) {
      const f = fixture("caverns80");
      mutate(f.manifest);
      const before = structuredClone(f);
      expect(() =>
        validateDistributionManifest(f.component, f.manifest, atomRevision),
      ).toThrow(/Caverns/);
      expect(f).toEqual(before);
    }
  });

  it("admits Caverns on A/B only with an allocation inside that resident ceiling", () => {
    const f = fixture("caverns80");
    f.component.target.capacity = 0xe200;
    expect(
      validateDistributionManifest(
        f.component,
        f.manifest,
        atomRevision,
        "triptych-cpu-v0.1-8m-ab",
      ),
    ).toEqual(f.manifest);
    // A tiny binary claim cannot hide an external stack or workspace.
    f.manifest.memory.stackStart = 0xe300;
    f.manifest.memory.stackEndExclusive = 0xe500;
    expect(() =>
      validateDistributionManifest(
        f.component,
        f.manifest,
        atomRevision,
        "triptych-cpu-v0.1-8m-ab",
      ),
    ).toThrow(/Caverns stack/);
  });

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
