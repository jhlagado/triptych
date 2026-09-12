import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto, createHash } from "node:crypto";
import {
  copyDiskBoxView,
  starterRecipe,
} from "../../crates/triptych-host-wasm/web/disk-box-app-store.js";
import { prepareSavedMachineAdoption } from "../../crates/triptych-host-wasm/web/disk-box-adoption.js";
import {
  validateDiskBoxManifest,
  prepareDiskBoxCheckpoint,
} from "../../crates/triptych-host-wasm/web/disk-box.js";
import { resolveDiskBoxConfiguration } from "../../crates/triptych-host-wasm/web/disk-box-runtime.js";

// Actual adapter function, with only its IndexedDB opener replaced. Hashing,
// adoption, manifest validation and byte-resolution remain production code.
const source = await readFile(
  new URL(
    "../../crates/triptych-host-wasm/web/disk-box-app-store.js",
    import.meta.url,
  ),
  "utf8",
);
const start = source.indexOf("export async function openDiskBoxAppStore("),
  end = source.indexOf("\nfunction token(", start);
assert(start >= 0 && end > start);
const factory = new Function(
  "openDiskBoxStore",
  "crypto",
  "validateDiskBoxManifest",
  "prepareDiskBoxCheckpoint",
  "resolveDiskBoxConfiguration",
  "prepareSavedMachineAdoption",
  "copyDiskBoxView",
  "hash",
  "same",
  "media",
  `${source.slice(start, end).replace("export ", "")}; return openDiskBoxAppStore;`,
);
const hash = async (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = "00000000-0000-4000-8000-000000000099";
async function adapter(snapshot) {
  const initial = await prepareSavedMachineAdoption(snapshot, {
    configurationId: id,
    name: "Original",
    crypto: webcrypto,
  });
  const head = {
    kind: "ready",
    manifest: initial.manifest,
    token: { kind: "disk-box", revision: 1, digest: "a".repeat(64) },
  };
  const store = await factory(
    async () => ({
      load: async () => head,
      readRawRecovery: async (name, key) =>
        name === "disk-box-state-v1"
          ? { revision: 1, digest: head.token.digest, operationId: "initial" }
          : { bytes: initial.newBlobs.get(key) },
    }),
    webcrypto,
    validateDiskBoxManifest,
    prepareDiskBoxCheckpoint,
    resolveDiskBoxConfiguration,
    prepareSavedMachineAdoption,
    copyDiskBoxView,
    hash,
    (a, b) => JSON.stringify(a) === JSON.stringify(b),
    (value) =>
      value.schema
        ? value.slots
        : value.bootstrap.profile === "triptych-cpu-v0.1-8m-ab"
          ? [value.drives.A, value.drives.B]
          : [value.drives.A],
  )({});
  assert.equal((await store.load()).kind, "ready");
  return { store, initial };
}

test("explicit legacy-to-8MAB profile migration binds new system A and retains old disk bytes", async () => {
  const old = {
    bootstrap: { profile: "legacy-e400", bytes: new Uint8Array(256) },
    drives: {
      A: { name: "Original A", bytes: new Uint8Array(256512) },
      B: null,
    },
  };
  const { store, initial } = await adapter(old);
  const candidate = await store.prepareView({
    bootstrap: {
      profile: "triptych-cpu-v0.1-8m-ab",
      bytes: new Uint8Array(256).fill(1),
    },
    drives: {
      A: { name: "Migrated A", bytes: new Uint8Array(8388608).fill(2) },
      B: { name: "New B", bytes: new Uint8Array(8388608).fill(3) },
    },
  });
  const configuration = candidate.manifest.configurations[0];
  assert.deepEqual(configuration.systemDisk, configuration.slots[0]);
  assert.equal(configuration.bootstrap.profile, "triptych-cpu-v0.1-8m-ab");
  assert.equal(configuration.configuredCount, 2);
  assert.notEqual(
    configuration.slots[0].diskId,
    initial.manifest.personalDisks[0].id,
  );
  assert.deepEqual(
    candidate.manifest.personalDisks.find(
      (disk) => disk.id === initial.manifest.personalDisks[0].id,
    ),
    initial.manifest.personalDisks[0],
  );
  assert.equal(initial.newBlobs.values().next().value.length, 256512);
});

test("same-profile replacement never promotes data A to the retained recovery binding", async () => {
  const old = {
    schema: "triptych-drive-set-v4",
    configuredCount: 1,
    bootstrap: {
      profile: "triptych-cpu-v0.1-2m-n01",
      bytes: new Uint8Array(256),
    },
    slots: [
      {
        instanceId: "00000000-0000-4000-8000-000000000001",
        name: "System",
        bytes: new Uint8Array(2097152),
      },
    ],
  };
  const { store, initial } = await adapter(old);
  const changed = copyDiskBoxView(old);
  changed.slots[0] = {
    instanceId: "00000000-0000-4000-8000-000000000002",
    name: "Data",
    bytes: new Uint8Array(2097152).fill(3),
  };
  const candidate = await store.prepareView(changed);
  assert.deepEqual(
    candidate.manifest.configurations[0].systemDisk,
    initial.manifest.configurations[0].systemDisk,
  );
  assert.equal(
    candidate.manifest.configurations[0].slots[0].diskId,
    changed.slots[0].instanceId,
  );
  assert.deepEqual(
    candidate.manifest.personalDisks.find(
      (disk) => disk.id === old.slots[0].instanceId,
    ),
    initial.manifest.personalDisks[0],
  );
});

test("recipe metadata preview fetches no bootstrap and creates no writable seed", async (t) => {
  const requests = [],
    digest = "a".repeat(64);
  const catalogue = {
    schema: "triptych-disk-catalogue-v1",
    images: ["system-2m-n04", "games-2m"].map((id, index) => ({
      id,
      revision: digest,
      name: id,
      geometry: "triptych-cpm-2m-v1",
      byteLength: 2097152,
      sha256: digest,
      asset: `${id}.img`,
      source: "https://example.org/source",
      license: "MIT",
      systemProfile: index === 0 ? "triptych-cpu-v0.1-2m-n04" : null,
    })),
  };
  t.mock.method(globalThis, "fetch", async (url) => {
    requests.push(url);
    assert.equal(url, "disk-catalogue.json");
    return new Response(JSON.stringify(catalogue));
  });
  const location = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { href: "https://example.org/site/" },
  });
  try {
    const deployment = {
      twoMibProfiles: [
        {
          configuredCount: 4,
          residentProfile: "triptych-cpu-v0.1-2m-n04",
          bootstrap: { asset: "bootstrap.bin", sha256: digest },
        },
      ],
    };
    const noSeed = {
      create_two_mib() {
        assert.fail("metadata cannot materialize writable seeds");
      },
    };
    const starter = await starterRecipe(deployment, noSeed, {
      loadAssets: false,
    });
    const library = await starterRecipe(deployment, noSeed, {
      libraryOnly: true,
      loadAssets: false,
    });
    assert.deepEqual(Object.keys(starter).sort(), ["descriptor", "digest"]);
    assert.equal(library.descriptor.slots[1], null);
    assert.equal(library.descriptor.slots[3], null);
    assert.notEqual(starter.digest, library.digest);
    assert.deepEqual(requests, ["disk-catalogue.json", "disk-catalogue.json"]);
    const blank = new Uint8Array(2097152).fill(0xe5);
    blank.fill(0, 0, 16384);
    assert.equal(await hash(blank), starter.descriptor.slots[1].seed.sha256);
  } finally {
    if (location) Object.defineProperty(globalThis, "location", location);
    else delete globalThis.location;
  }
});
