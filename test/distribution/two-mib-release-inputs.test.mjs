import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePortableCpmSource } from "../../tools/lib/portable-cpm-source.mjs";
import { validateDistributionManifest } from "../../tools/lib/distribution-manifests.mjs";
import { validateComponentLock } from "../../tools/lib/component-lock.mjs";
import { readVerifiedRelease } from "../../tools/lib/verified-release.mjs";

const root = resolve(import.meta.dirname, "../..");
const family = "third_party/portable-cpm/2m/v0.1.4";
const revision = "d28fc52774c967d1422b3b814d51c069247504c1";
const atom = "802b5c2d320bec777f427755ff2d7338e3b80a05";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const profileId = (n) => `triptych-cpu-v0.1-2m-n${String(n).padStart(2, "0")}`;
const lockPath = (n) =>
  `distribution/residents-2m/n${String(n).padStart(2, "0")}.lock.json`;
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value));

async function fixture(run) {
  const temporary = await mkdtemp(join(tmpdir(), "triptych-2m-inputs-"));
  const directory = join(temporary, "triptych");
  try {
    await cp(join(root, family), join(directory, family), { recursive: true });
    await cp(
      join(root, "distribution/residents-2m"),
      join(directory, "distribution/residents-2m"),
      { recursive: true },
    );
    await run(directory);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

describe("retained two-MiB release inputs, without assembly", () => {
  for (let n = 1; n <= 16; n++) {
    it(`verifies exact profile ${n} source, binary, provenance and placement`, async () => {
      const lock = validateComponentLock(await json(join(root, lockPath(n))), {
        recipes: new Set(["verified-release"]),
      });
      expect(lock.targetProfile).toBe(profileId(n));
      expect(lock.disk).toEqual({
        bytes: 2097152,
        recordBytes: 128,
        systemRecords: 128,
      });
      expect(lock.atom.revision).toBe(atom);
      // Independent arithmetic, not the production layout helper.
      const ccp = 0x10000 - 256 * Math.ceil(n / 2) - 1024 - 3584 - 2048;
      for (const [index, component] of lock.components.entries()) {
        expect(component.id).toBe(index === 0 ? "ccp" : "bdos");
        expect(component.source.revision).toBe(revision);
        expect(component.target).toEqual({
          origin: ccp + (index ? 2048 : 0),
          capacity: index ? 3584 : 2048,
        });
        const released = await readVerifiedRelease(root, component);
        expect(released.manifest.version).toBe("0.1.4");
        expect(released.manifest.targetProfile).toBe(profileId(n));
        validateDistributionManifest(
          component,
          released.manifest,
          atom,
          profileId(n),
        );
        const source = await preparePortableCpmSource(
          root,
          component.id,
          profileId(n),
        );
        const metadata = released.manifest.components[index];
        expect(sha(source)).toBe(metadata.preparedSourceSha256);
        expect(sha(await readFile(join(root, family, metadata.source)))).toBe(
          metadata.sourceSha256,
        );
        expect(sha(released.bytes)).toBe(metadata.sha256);
        expect(
          source.startsWith(`CCPBAS EQU $${ccp.toString(16).toUpperCase()}\n`),
        ).toBe(true);
      }
    });
  }

  it("keeps the historical default and A/B release-source paths admissible", async () => {
    for (const profile of ["triptych-cpu-v0.1", "triptych-cpu-v0.1-8m-ab"]) {
      for (const id of ["ccp", "bdos"]) {
        const source = await preparePortableCpmSource(root, id, profile);
        expect(source).toContain(
          profile.endsWith("-8m-ab")
            ? "CCPBAS EQU $E300\n"
            : "CCPBAS EQU $E400\n",
        );
      }
    }
  });

  it.each([
    "triptych-cpu-v0.1-2m-n00",
    "triptych-cpu-v0.1-2m-n17",
    "triptych-cpu-v0.1-2m-n1",
    "triptych-cpu-v0.1-2m-n01/../n02",
    "test-low-memory-v1",
  ])("rejects unsupported identity %s", async (id) => {
    await expect(preparePortableCpmSource(root, "ccp", id)).rejects.toThrow(
      /unsupported/,
    );
  });

  it("rejects n02 manifest substitution for n01 despite identical resident bytes", async () => {
    await fixture(async (directory) => {
      const one = await json(join(directory, lockPath(1)));
      const two = await json(join(directory, lockPath(2)));
      for (let i = 0; i < 2; i++)
        expect(one.components[i].artifact.sha256).toBe(
          two.components[i].artifact.sha256,
        );
      const replacement = await readFile(
        join(directory, two.components[0].artifact.manifest),
      );
      await writeFile(
        join(directory, one.components[0].artifact.manifest),
        replacement,
      );
      for (const component of one.components) {
        const path = join(directory, component.artifact.provenance);
        const provenance = await json(path);
        provenance.manifestSha256 = sha(replacement);
        await save(path, provenance);
        await expect(
          preparePortableCpmSource(directory, component.id, profileId(1)),
        ).rejects.toThrow(/OS target profile/);
      }
    });
  });

  it.each([
    ["binary", /artifact SHA-256/],
    ["source", /source snapshot digest/],
    ["provenance", /provenance revision/],
    ["manifest-version", /release version/],
    ["prepared-source", /profiled source digest/],
    ["lock-geometry", /resident disk/],
    ["lock-revision", /released source revision/],
    ["lock-origin", /OS target/],
  ])("rejects tampered %s", async (kind, error) => {
    await fixture(async (directory) => {
      const path = join(directory, lockPath(1));
      const lock = await json(path);
      const c = lock.components[0];
      if (kind === "binary" || kind === "source") {
        const file = join(
          directory,
          kind === "binary" ? c.artifact.path : `${family}/src/ccp.asm`,
        );
        const bytes = await readFile(file);
        bytes[0] ^= 1;
        await writeFile(file, bytes);
      } else if (kind === "provenance") {
        const file = join(directory, c.artifact.provenance),
          value = await json(file);
        value.revision = "0".repeat(40);
        await save(file, value);
      } else if (kind.startsWith("lock-")) {
        if (kind === "lock-geometry") lock.disk.bytes = 8388608;
        if (kind === "lock-revision") c.source.revision = "0".repeat(40);
        if (kind === "lock-origin") c.target.origin -= 256;
        await save(path, lock);
      } else {
        const file = join(directory, c.artifact.manifest),
          value = await json(file);
        if (kind === "manifest-version") value.version = "0.1.3";
        else value.components[0].preparedSourceSha256 = "0".repeat(64);
        await save(file, value);
        const provenancePath = join(directory, c.artifact.provenance);
        const provenance = await json(provenancePath);
        provenance.manifestSha256 = sha(await readFile(file));
        await save(provenancePath, provenance);
      }
      await expect(
        preparePortableCpmSource(directory, "ccp", profileId(1)),
      ).rejects.toThrow(error);
    });
  });

  it("missing retained source or binary fails rather than using another checkout", async () => {
    for (const source of [false, true]) {
      await fixture(async (directory) => {
        const lock = await json(join(directory, lockPath(1)));
        const relative = source
          ? `${family}/src/ccp.asm`
          : lock.components[0].artifact.path;
        // An enticing adjacent checkout inside the disposable fixture is not an input.
        const sibling = join(directory, "..", "portable-cpm");
        await mkdir(sibling);
        await cp(join(directory, family, "src"), join(sibling, "src"), {
          recursive: true,
        });
        await rm(join(directory, relative));
        await expect(
          preparePortableCpmSource(directory, "ccp", profileId(1)),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    }
  });
});
