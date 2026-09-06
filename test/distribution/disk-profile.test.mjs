import { createHash, webcrypto } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  fetchLargeAbDiskSystem,
  fetchLargeDiskSystem,
} from "../../crates/triptych-host-wasm/web/disk-profile.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const abProfile = "triptych-cpu-v0.1-8m-ab";
const abSystemAsset = "system-triptych-cpm-8m-ab-v1.bin";
const abBootstrapAsset = "bootstrap-triptych-cpm-8m-ab-v1.bin";
let deployment;
let payloads;
let requests;
let options;
let profile;

beforeEach(() => {
  const system = new Uint8Array(16384);
  system.fill(0x55, 0, 0x800);
  system.fill(0x66, 0x800, 0x1600);
  system.fill(0x77, 0x1600, 0x1900);
  const bootstrap = new Uint8Array(256).fill(0x88);
  const singleSystem = new Uint8Array(16384);
  singleSystem.fill(0x11, 0, 0x800);
  singleSystem.fill(0x22, 0x800, 0x1600);
  singleSystem.fill(0x33, 0x1600, 0x1a00);
  const singleBootstrap = new Uint8Array(256).fill(0xc3);
  profile = {
    id: "triptych-cpm-8m-v1",
    residentProfile: abProfile,
    imageBytes: 8388608,
    systemBytes: 16384,
    drives: 2,
    systemAsset: abSystemAsset,
    systemSha256: hash(system),
    bootstrapAsset: abBootstrapAsset,
    bootstrapSha256: hash(bootstrap),
    residentLockSha256: "c".repeat(64),
    ccpSha256: hash(system.subarray(0, 0x800)),
    bdosSha256: hash(system.subarray(0x800, 0x1600)),
    bios: {
      source: "system/cpm/bios-8m-ab.asm",
      sourceSha256: "d".repeat(64),
      sha256: hash(system.subarray(0x1600, 0x1a00)),
      liveEnd: 0xfc00,
    },
  };
  payloads = new Map([
    [abSystemAsset, system],
    [abBootstrapAsset, bootstrap],
    ["system-triptych-cpm-8m-v1.bin", singleSystem],
    ["bootstrap.bin", singleBootstrap],
  ]);
  deployment = {
    schema: "triptych-browser-deployment-v1",
    diskProfiles: [
      {
        id: "triptych-cpm-8m-v1",
        residentProfile: "triptych-cpu-v0.1-8m-a",
        imageBytes: 8388608,
        systemBytes: 16384,
        drives: 1,
        systemAsset: "system-triptych-cpm-8m-v1.bin",
        bootstrapSha256: hash(singleBootstrap),
        ccpSha256: hash(singleSystem.subarray(0, 0x800)),
        bdosSha256: hash(singleSystem.subarray(0x800, 0x1600)),
        bios: {
          source: "system/cpm/bios-8m.asm",
          sourceSha256: "b".repeat(64),
          sha256: hash(singleSystem.subarray(0x1600, 0x1a00)),
        },
      },
      profile,
    ],
    assets: [...payloads].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
  };
  requests = [];
  options = {
    deployment,
    baseUrl: "https://example.test/project/",
    crypto: webcrypto,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const bytes = payloads.get(new URL(url).pathname.split("/").at(-1));
      return { ok: true, arrayBuffer: async () => bytes.buffer };
    },
  };
});

function updateIdentity(path) {
  const bytes = payloads.get(path);
  Object.assign(
    deployment.assets.find((entry) => entry.path === path),
    {
      bytes: bytes.length,
      sha256: hash(bytes),
    },
  );
  profile[path === abSystemAsset ? "systemSha256" : "bootstrapSha256"] =
    hash(bytes);
}

describe("verified browser resident profiles", () => {
  it("loads distinct A/B residents and bootstrap without any loaded E400 inputs", async () => {
    const result = await fetchLargeAbDiskSystem(options);
    expect(result).toEqual({
      system: payloads.get(abSystemAsset),
      bootstrap: payloads.get(abBootstrapAsset),
      profile: abProfile,
    });
    expect(requests).toEqual(
      [abSystemAsset, abBootstrapAsset].map((path) => ({
        url: `https://example.test/project/${path}`,
        init: { cache: "no-store", redirect: "error" },
      })),
    );
    result.system[0] = 0;
    result.bootstrap[0] = 0;
    expect(payloads.get(abSystemAsset)[0]).toBe(0x55);
    expect(payloads.get(abBootstrapAsset)[0]).toBe(0x88);
  });

  it("retains one-drive selection when another resident shares its geometry id", async () => {
    const system = payloads.get("system-triptych-cpm-8m-v1.bin");
    const result = await fetchLargeDiskSystem({
      ...options,
      bootstrap: payloads.get("bootstrap.bin"),
      ccp: system.slice(0, 0x800),
      bdos: system.slice(0x800, 0x1600),
    });
    expect(result).toEqual(system);
    expect(requests).toHaveLength(1);
  });

  it("keeps the historical one-profile deployment API supported", async () => {
    deployment.diskProfiles.pop();
    deployment.assets = deployment.assets.filter(
      (entry) => !entry.path.includes("8m-ab"),
    );
    const system = payloads.get("system-triptych-cpm-8m-v1.bin");
    expect(
      await fetchLargeDiskSystem({
        ...options,
        bootstrap: payloads.get("bootstrap.bin"),
        ccp: system.slice(0, 0x800),
        bdos: system.slice(0x800, 0x1600),
      }),
    ).toEqual(system);
  });

  it("captures caller metadata before the first network wait", async () => {
    const work = fetchLargeAbDiskSystem(options);
    profile.bios.liveEnd = 0;
    profile.ccpSha256 = "0".repeat(64);
    deployment.assets.length = 0;
    deployment.diskProfiles.length = 0;
    expect((await work).profile).toBe(abProfile);
  });

  it.each([
    [
      "schema",
      (d) => {
        d.schema = "unknown";
      },
    ],
    [
      "missing profiles",
      (d) => {
        delete d.diskProfiles;
      },
    ],
    [
      "missing A/B",
      (d) => {
        d.diskProfiles.pop();
      },
    ],
    [
      "duplicate A/B",
      (d) => {
        d.diskProfiles.push(structuredClone(profile));
      },
    ],
    [
      "geometry",
      () => {
        profile.id = "ibm3740";
      },
    ],
    [
      "resident label",
      () => {
        profile.residentProfile = "unknown";
      },
    ],
    [
      "drive count",
      () => {
        profile.drives = 1;
      },
    ],
    [
      "image length",
      () => {
        profile.imageBytes--;
      },
    ],
    [
      "system length",
      () => {
        profile.systemBytes--;
      },
    ],
    [
      "system alias",
      () => {
        profile.systemAsset = "system-triptych-cpm-8m-v1.bin";
      },
    ],
    [
      "bootstrap alias",
      () => {
        profile.bootstrapAsset = "bootstrap.bin";
      },
    ],
    [
      "unknown field",
      () => {
        profile.extra = true;
      },
    ],
    [
      "missing field",
      () => {
        delete profile.residentLockSha256;
      },
    ],
    [
      "unknown BIOS field",
      () => {
        profile.bios.extra = true;
      },
    ],
    [
      "missing BIOS",
      () => {
        profile.bios = null;
      },
    ],
    [
      "BIOS path",
      () => {
        profile.bios.source = "system/cpm/bios.asm";
      },
    ],
    [
      "BIOS lower bound",
      () => {
        profile.bios.liveEnd = 0xf900;
      },
    ],
    [
      "BIOS upper bound",
      () => {
        profile.bios.liveEnd = 0xfc01;
      },
    ],
    [
      "BIOS fractional bound",
      () => {
        profile.bios.liveEnd = 0xfbff + 0.5;
      },
    ],
    [
      "unknown asset field",
      (d) => {
        d.assets[0].extra = true;
      },
    ],
    [
      "duplicate asset",
      (d) => {
        d.assets.push({ ...d.assets[0] });
      },
    ],
    [
      "missing asset",
      (d) => {
        d.assets.shift();
      },
    ],
    [
      "asset length",
      (d) => {
        d.assets[0].bytes--;
      },
    ],
    [
      "asset digest",
      (d) => {
        d.assets[0].sha256 = "0".repeat(64);
      },
    ],
  ])("rejects %s before fetching", async (_label, mutate) => {
    mutate(deployment);
    await expect(fetchLargeAbDiskSystem(options)).rejects.toThrow(
      "Disk upgrade:",
    );
    expect(requests).toHaveLength(0);
  });

  it.each([
    "systemSha256",
    "bootstrapSha256",
    "residentLockSha256",
    "ccpSha256",
    "bdosSha256",
  ])("rejects malformed %s", async (key) => {
    profile[key] = "BAD";
    await expect(fetchLargeAbDiskSystem(options)).rejects.toThrow(
      "unsupported A/B",
    );
    expect(requests).toHaveLength(0);
  });

  it.each([abSystemAsset, abBootstrapAsset])(
    "rejects changed %s bytes and length",
    async (path) => {
      payloads.get(path)[0] ^= 1;
      await expect(fetchLargeAbDiskSystem(options)).rejects.toThrow(
        "asset verification failed",
      );
      payloads.set(path, payloads.get(path).slice(1));
      updateIdentity(path);
      await expect(fetchLargeAbDiskSystem(options)).rejects.toThrow(
        "asset identity mismatch",
      );
    },
  );

  it.each([0, 0x800, 0x1600, 0x1900, 0x1a00, 0x3fff])(
    "rejects changed slot/reserved byte %i despite a rehashed complete asset",
    async (offset) => {
      payloads.get(abSystemAsset)[offset] ^= 1;
      updateIdentity(abSystemAsset);
      // Even rehashing BIOS cannot authorize nonzero bytes after liveEnd.
      if (offset === 0x1900)
        profile.bios.sha256 = hash(
          payloads.get(abSystemAsset).subarray(0x1600, 0x1a00),
        );
      await expect(fetchLargeAbDiskSystem(options)).rejects.toThrow(
        "resident slots or reserved bytes",
      );
    },
  );

  it("rejects failed requests, unavailable hashing and non-HTTP bases", async () => {
    await expect(
      fetchLargeAbDiskSystem({
        ...options,
        fetch: async () => ({ ok: false }),
      }),
    ).rejects.toThrow("could not be loaded");
    await expect(
      fetchLargeAbDiskSystem({ ...options, crypto: {} }),
    ).rejects.toThrow("SHA-256 unavailable");
    requests.length = 0;
    await expect(
      fetchLargeAbDiskSystem({ ...options, baseUrl: "file:///tmp/" }),
    ).rejects.toThrow("invalid asset URL");
    expect(requests).toHaveLength(0);
  });
});
