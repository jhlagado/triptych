import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { fetchPublicDriveSet } from "../../crates/triptych-host-wasm/web/public-distribution.js";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const systemPath = "system-triptych-cpm-8m-ab-v1.bin";
const bootstrapPath = "bootstrap-triptych-cpm-8m-ab-v1.bin";
const paths = { A: "drive-a-system.img", B: "drive-b-games.img" };

// Synthetic hash-consistent residents/media exercise loader admission only.
// Actual filesystem validity, boot and games belong to browser acceptance.
function fixture() {
  const system = new Uint8Array(16384);
  system.fill(0x55, 0, 0x800);
  system.fill(0x66, 0x800, 0x1600);
  system.fill(0x77, 0x1600, 0x1900);
  const bootstrap = new Uint8Array(256).fill(0x88);
  const A = new Uint8Array(8388608).fill(0xa1);
  A.set(system);
  const B = new Uint8Array(8388608).fill(0xb2);
  B.fill(0, 0, system.length);
  const payloads = new Map([
    [systemPath, system],
    [bootstrapPath, bootstrap],
    [paths.A, A],
    [paths.B, B],
  ]);
  const deployment = {
    schema: "triptych-browser-deployment-v1",
    diskProfiles: [
      {
        id: "triptych-cpm-8m-v1",
        residentProfile: "triptych-cpu-v0.1-8m-ab",
        imageBytes: 8388608,
        systemBytes: 16384,
        drives: 2,
        systemAsset: systemPath,
        systemSha256: hash(system),
        bootstrapAsset: bootstrapPath,
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
      },
    ],
    assets: [...payloads].map(([path, bytes]) => ({
      path,
      bytes: bytes.length,
      sha256: hash(bytes),
    })),
    publicDrives: {
      schema: "triptych-public-drives-v1",
      profile: "triptych-cpu-v0.1-8m-ab",
      bootstrapAsset: bootstrapPath,
      drives: Object.fromEntries(
        Object.entries(paths).map(([drive, path]) => [
          drive,
          {
            name: path,
            path,
            bytes: 8388608,
            sha256: hash(payloads.get(path)),
          },
        ]),
      ),
    },
  };
  const requests = [];
  const options = {
    deployment,
    baseUrl: "https://example.test/triptych/",
    crypto: webcrypto,
    fetch: async (url, init) => {
      requests.push({ url, init });
      const path = new URL(url).pathname.split("/").at(-1);
      assert(payloads.has(path), `unexpected asset ${path}`);
      return {
        ok: true,
        arrayBuffer: async () => payloads.get(path).slice().buffer,
      };
    },
  };
  const updateImageIdentity = (drive) => {
    const path = paths[drive];
    const sha256 = hash(payloads.get(path));
    deployment.publicDrives.drives[drive].sha256 = sha256;
    deployment.assets.find((entry) => entry.path === path).sha256 = sha256;
  };
  return { options, deployment, payloads, requests, updateImageIdentity };
}

test("returns a complete private A/B snapshot with exact resident identity", async () => {
  const { options, payloads, requests } = fixture();
  const result = await fetchPublicDriveSet(options);
  assert.equal(result.bootstrap.profile, "triptych-cpu-v0.1-8m-ab");
  assert.deepEqual(result.bootstrap.bytes, payloads.get(bootstrapPath));
  for (const [drive, path] of Object.entries(paths)) {
    assert.equal(result.drives[drive].name, path);
    assert.deepEqual(result.drives[drive].bytes, payloads.get(path));
    payloads.get(path).fill(0);
    assert.equal(
      result.drives[drive].bytes[16384],
      drive === "A" ? 0xa1 : 0xb2,
    );
  }
  payloads.get(bootstrapPath).fill(0);
  assert.equal(result.bootstrap.bytes[0], 0x88);
  assert.deepEqual(
    requests,
    [systemPath, bootstrapPath, paths.A, paths.B].map((path) => ({
      url: `https://example.test/triptych/${path}`,
      init: { cache: "no-store", redirect: "error" },
    })),
  );
});

test("captures caller metadata before the first asynchronous fetch", async () => {
  const { options, deployment, payloads } = fixture();
  const pending = fetchPublicDriveSet(options);
  deployment.publicDrives.profile = "legacy-e400";
  deployment.publicDrives.drives.A.name = "changed.img";
  deployment.publicDrives.drives.B.sha256 = "0".repeat(64);
  deployment.diskProfiles.length = 0;
  deployment.assets.length = 0;
  const result = await pending;
  assert.equal(result.bootstrap.profile, "triptych-cpu-v0.1-8m-ab");
  assert.equal(result.drives.A.name, paths.A);
  assert.deepEqual(result.drives.B.bytes, payloads.get(paths.B));
});

test("a verified A cannot resolve a partial snapshot while B is pending or fails", async () => {
  const { options } = fixture();
  const originalFetch = options.fetch;
  let rejectB;
  const bPending = new Promise((_, reject) => {
    rejectB = reject;
  });
  let signalA;
  const aVerified = new Promise((resolve) => {
    signalA = resolve;
  });
  options.fetch = async (url, init) =>
    url.endsWith(paths.B) ? bPending : originalFetch(url, init);
  options.crypto = {
    subtle: {
      digest: async (algorithm, bytes) => {
        const digest = await webcrypto.subtle.digest(algorithm, bytes);
        if (bytes.length === 8388608 && bytes[0] === 0x55) signalA();
        return digest;
      },
    },
  };
  let published;
  const pending = fetchPublicDriveSet(options).then((snapshot) => {
    published = snapshot;
    return snapshot;
  });
  const rejected = assert.rejects(pending, /controlled B fetch failure/);
  await aVerified;
  await setImmediate();
  assert.equal(published, undefined);
  rejectB(new Error("controlled B fetch failure"));
  await rejected;
  assert.equal(published, undefined);
});

test("rejects failed, truncated or corrupt B without returning any snapshot", async (t) => {
  for (const failure of ["http", "size", "hash"]) {
    await t.test(failure, async () => {
      const { options, payloads } = fixture();
      const originalFetch = options.fetch;
      if (failure === "http") {
        options.fetch = async (url, init) =>
          url.endsWith(paths.B) ? { ok: false } : originalFetch(url, init);
      } else if (failure === "size") payloads.set(paths.B, new Uint8Array(1));
      else payloads.get(paths.B)[16384] ^= 1;
      let published;
      await assert.rejects(
        fetchPublicDriveSet(options).then((snapshot) => {
          published = snapshot;
        }),
        /B: image (could not be loaded|size|verification failed)/,
      );
      assert.equal(published, undefined);
    });
  }
});

test("rejects hash-consistent images with the wrong reserved-system role", async (t) => {
  for (const drive of ["A", "B"]) {
    await t.test(drive, async () => {
      const { options, payloads, updateImageIdentity } = fixture();
      payloads.get(paths[drive])[0] ^= 1;
      updateImageIdentity(drive);
      await assert.rejects(
        fetchPublicDriveSet(options),
        /system area differs from its role/,
      );
    });
  }
});

test("rejects unsupported or mixed distribution metadata before any network fetch", async (t) => {
  const cases = {
    profile: (d) => {
      d.publicDrives.profile = "triptych-cpu-v0.1-8m-a";
    },
    bootstrap: (d) => {
      d.publicDrives.bootstrapAsset = "bootstrap.bin";
    },
    missingB: (d) => {
      delete d.publicDrives.drives.B;
    },
    extraDrive: (d) => {
      d.publicDrives.drives.C = d.publicDrives.drives.B;
    },
    swappedRole: (d) => {
      d.publicDrives.drives.B.path = paths.A;
    },
    missingAsset: (d) => {
      d.assets = d.assets.filter((entry) => entry.path !== paths.B);
    },
    duplicateAsset: (d) => {
      d.assets.push({ ...d.assets.find((entry) => entry.path === paths.B) });
    },
    mixedAssetHash: (d) => {
      d.assets.find((entry) => entry.path === paths.B).sha256 = "0".repeat(64);
    },
    residentProfile: (d) => {
      d.diskProfiles[0].residentProfile = "triptych-cpu-v0.1-8m-a";
    },
    mixedBootstrapHash: (d) => {
      d.assets.find((entry) => entry.path === bootstrapPath).sha256 =
        "0".repeat(64);
    },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    await t.test(name, async () => {
      const { options, deployment, requests } = fixture();
      mutate(deployment);
      await assert.rejects(
        fetchPublicDriveSet(options),
        /Supplied disks:|Disk upgrade:/,
      );
      assert.deepEqual(requests, []);
    });
  }
});
