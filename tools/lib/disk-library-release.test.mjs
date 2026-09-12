import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { captureDiskLibraryRelease as capture } from "./disk-library-release.mjs";
import { mergeDiskLibraryRetention } from "./disk-library-retention.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function fixture(version = 1) {
  const system = new Uint8Array(16384).fill(version),
    bootstrap = new Uint8Array(256).fill(version),
    blankSeed = new Uint8Array(2097152);
  const logicalSystem = "system-triptych-cpm-2m-n04-v1.bin",
    logicalBootstrap = "bootstrap-triptych-cpm-2m-n04-v1.bin";
  const profile = {
    configuredCount: 4,
    residentProfile: "triptych-cpu-v0.1-2m-n04",
    system: {
      asset: logicalSystem,
      bytes: system.length,
      sha256: hash(system),
    },
    bootstrap: {
      asset: logicalBootstrap,
      bytes: bootstrap.length,
      sha256: hash(bootstrap),
    },
  };
  const admission = {
    schema: "triptych-browser-deployment-v1",
    twoMibProfiles: [profile],
    assets: [
      { path: logicalSystem, bytes: system.length, sha256: hash(system) },
      {
        path: logicalBootstrap,
        bytes: bootstrap.length,
        sha256: hash(bootstrap),
      },
    ],
  };
  const assets = new Map([
    [logicalSystem, system],
    [logicalBootstrap, bootstrap],
  ]);
  const images = ["system-2m-n04", "games-2m"].map((id, index) => {
    const bytes = new Uint8Array(2097152);
    if (!index) bytes.set(system);
    else bytes[16384] = version;
    const sha256 = hash(bytes),
      asset = `library-${id}-${sha256}.img`;
    assets.set(asset, bytes);
    return {
      id,
      revision: sha256,
      name: id,
      geometry: "triptych-cpm-2m-v1",
      byteLength: bytes.length,
      sha256,
      asset,
      source: `https://example.test/source/${version}`,
      license: "GPL-3.0-only",
      systemProfile: index ? null : profile.residentProfile,
    };
  });
  const provenance = {
    schema: "triptych-disk-library-provenance-v1",
    machine: { revision: String(version) },
    system: profile,
    images: images.map((image) => ({
      asset: image.asset,
      bytes: image.byteLength,
      sha256: image.sha256,
    })),
  };
  return {
    catalogueBytes: json({ schema: "triptych-disk-catalogue-v1", images }),
    provenanceBytes: json(provenance),
    admissionBytes: json(admission),
    assets,
    blankSeed,
  };
}
const recipe = (captured, id) =>
  captured.manifest.recipes.find((row) => row.id === id);

test("captures exact publication evidence and origin-independent starter/library templates", () => {
  const input = fixture(),
    result = capture(input);
  assert.equal(result.manifest.recipes.length, 2);
  assert.equal(result.manifest.admissions.length, 1);
  const starter = recipe(result, "starter"),
    library = recipe(result, "library");
  assert.deepEqual(
    starter.slots.map((slot) => slot?.kind),
    ["published", "writable-role", "published", "writable-role"],
  );
  assert.deepEqual(
    library.slots.map((slot) => slot?.kind),
    ["published", undefined, "published", undefined],
  );
  assert.equal(starter.slots[1].seed.asset, starter.slots[3].seed.asset);
  assert.match(starter.revision, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(starter).includes("https://"));
  const admission = result.manifest.admissions[0];
  assert.deepEqual(
    result.assets.get(admission.envelope),
    new Uint8Array(input.admissionBytes),
  );
  assert.deepEqual(
    result.assets.get(starter.provenance),
    new Uint8Array(input.provenanceBytes),
  );
  for (const binding of admission.bindings)
    assert.deepEqual(
      result.assets.get(binding.asset),
      input.assets.get(binding.path),
    );
  assert(
    result.manifest.assets.some(
      (row) => row.sha256 === hash(input.catalogueBytes),
    ),
  );
  assert.equal(
    new Set(result.manifest.assets.map((row) => row.path)).size,
    result.manifest.assets.length,
  );
  assert.deepEqual(
    capture(input).manifest,
    result.manifest,
    "same inputs produce the same revisions",
  );
  input.blankSeed.fill(99);
  input.assets.get(admission.bindings[0].path).fill(99);
  assert.equal(result.assets.get(starter.slots[1].seed.asset)[0], 0);
  assert.equal(result.assets.get(admission.bindings[0].asset)[0], 1);
});

test("revision covers seed, admission, provenance and all portable template fields", () => {
  const original = capture(fixture()),
    changedSeedInput = fixture();
  changedSeedInput.blankSeed[20000] = 5;
  const changedSeed = capture(changedSeedInput);
  assert.notEqual(
    recipe(original, "starter").revision,
    recipe(changedSeed, "starter").revision,
  );
  assert.equal(
    recipe(original, "library").revision,
    recipe(changedSeed, "library").revision,
  );
  const changedProvenanceInput = fixture(),
    provenance = JSON.parse(changedProvenanceInput.provenanceBytes);
  provenance.note = "additional retained provenance";
  changedProvenanceInput.provenanceBytes = json(provenance);
  const changedProvenance = capture(changedProvenanceInput);
  for (const id of ["starter", "library"])
    assert.notEqual(
      recipe(original, id).revision,
      recipe(changedProvenance, id).revision,
    );
  const changedSystem = capture(fixture(2));
  for (const id of ["starter", "library"])
    assert.notEqual(
      recipe(original, id).revision,
      recipe(changedSystem, id).revision,
    );
});

test("captured releases merge while preserving old byte evidence and recipe lookups", () => {
  const first = capture(fixture(1)),
    second = capture(fixture(2));
  const retained = mergeDiskLibraryRetention(first, second, {
    defaults: second.manifest.defaults,
  });
  assert.equal(retained.manifest.recipes.length, 4);
  assert.equal(retained.manifest.admissions.length, 2);
  for (const row of first.manifest.recipes)
    assert.deepEqual(
      retained.manifest.recipes.find(
        (candidate) =>
          candidate.id === row.id && candidate.revision === row.revision,
      ),
      row,
    );
  for (const [path, bytes] of first.assets)
    assert.deepEqual(retained.assets.get(path), bytes);
  assert.deepEqual(retained.manifest.defaults, second.manifest.defaults);
});

test("rejects mixed provenance, missing assets, wrong seed and corrupt publication bytes", () => {
  for (const mutate of [
    (input) => {
      input.provenanceBytes = fixture(2).provenanceBytes;
    },
    (input) => {
      input.assets.delete(input.assets.keys().next().value);
    },
    (input) => {
      input.assets.values().next().value.fill(99);
    },
    (input) => {
      input.blankSeed = new Uint8Array(3);
    },
    (input) => {
      input.blankSeed[0] = 1;
    },
    (input) => {
      input.catalogueBytes = Buffer.from('{"schema":1,"schema":1}');
    },
    (input) => {
      input.provenanceBytes = Buffer.from("not JSON");
    },
    (input) => {
      input.admissionBytes = new Uint8Array(17 * 1024 * 1024);
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => capture(input), /Disk library release/);
  }
});

test("refuses incomplete or ambiguous current catalogue and wrong N4 envelope", () => {
  const missing = fixture(),
    catalogue = JSON.parse(missing.catalogueBytes);
  catalogue.images.pop();
  missing.catalogueBytes = json(catalogue);
  assert.throws(() => capture(missing), /exactly one current games-2m/);
  const ambiguous = fixture(),
    duplicated = JSON.parse(ambiguous.catalogueBytes);
  duplicated.images.push({ ...duplicated.images[1], id: "system-2m-n04" });
  ambiguous.catalogueBytes = json(duplicated);
  assert.throws(() => capture(ambiguous), /exactly one current system-2m-n04/);
  const wrong = fixture(),
    envelope = JSON.parse(wrong.admissionBytes);
  envelope.twoMibProfiles[0].configuredCount = 2;
  wrong.admissionBytes = json(envelope);
  assert.throws(() => capture(wrong), /qualified N4/);
});

test("capture ignores auxiliary typed-array iterators and getters", () => {
  const input = fixture();
  input.blankSeed[Symbol.iterator] = function* () {
    throw new Error("iterator invoked");
  };
  Object.defineProperty(input.blankSeed, "byteLength", {
    get() {
      throw new Error("getter invoked");
    },
  });
  assert(capture(input).manifest.recipes.length === 2);
});

test("curated link image revisions must identify their actual byte hash", () => {
  const input = fixture(),
    catalogue = JSON.parse(input.catalogueBytes);
  catalogue.images[0].revision = "mutable-latest";
  input.catalogueBytes = json(catalogue);
  assert.throws(
    () => capture(input),
    /image revision must equal its byte hash/,
  );
});

test("retained provenance must cover exactly the catalogue image identities", () => {
  for (const mutate of [
    (provenance) => {
      provenance.images[0].sha256 = "0".repeat(64);
    },
    (provenance) => {
      provenance.images[1].bytes = 1;
    },
    (provenance) => {
      provenance.images = [];
    },
    (provenance) => {
      provenance.images[0].asset = "other.img";
    },
    (provenance) => {
      provenance.images.push(provenance.images[0]);
    },
    (provenance) => {
      provenance.images[1] = provenance.images[0];
    },
    (provenance) => {
      provenance.images[0].systemProfile = null;
    },
    (provenance) => {
      provenance.images[1].systemProfile = "triptych-cpu-v0.1-2m-n04";
    },
  ]) {
    const input = fixture(),
      provenance = JSON.parse(input.provenanceBytes);
    mutate(provenance);
    input.provenanceBytes = json(provenance);
    assert.throws(() => capture(input), /provenance image/);
  }
  const input = fixture(),
    provenance = JSON.parse(input.provenanceBytes),
    catalogue = JSON.parse(input.catalogueBytes);
  for (const image of provenance.images)
    image.systemProfile = catalogue.images.find(
      (row) => row.asset === image.asset,
    ).systemProfile;
  input.provenanceBytes = json(provenance);
  assert.equal(capture(input).manifest.recipes.length, 2);
});

test("aggregate output bounds reject before reading or copying image payloads", () => {
  const input = fixture(),
    catalogue = JSON.parse(input.catalogueBytes),
    provenance = JSON.parse(input.provenanceBytes);
  const shared = new Uint8Array(8388608),
    sha256 = hash(shared);
  for (let i = 0; i < 130; i++) {
    const image = {
      ...catalogue.images[1],
      id: `extra-${i}`,
      asset: `extra-${i}-${sha256}.img`,
      revision: sha256,
      sha256,
      geometry: "triptych-cpm-8m-v1",
      byteLength: shared.length,
    };
    catalogue.images.push(image);
    provenance.images.push({
      asset: image.asset,
      bytes: image.byteLength,
      sha256,
    });
    input.assets.set(image.asset, shared);
  }
  input.catalogueBytes = json(catalogue);
  input.provenanceBytes = json(provenance);
  const original = input.assets.get.bind(input.assets);
  let reads = 0;
  input.assets.get = (path) => {
    if (++reads === 4) throw new Error("stopped before excessive allocation");
    return original(path);
  };
  assert.throws(() => capture(input), /aggregate byte bound/);
  assert.equal(reads, 0);
});

test("metadata budgets reject before reading otherwise in-budget payloads", () => {
  const input = fixture(),
    catalogue = JSON.parse(input.catalogueBytes),
    provenance = JSON.parse(input.provenanceBytes);
  const shared = new Uint8Array(256512),
    sha256 = hash(shared);
  for (let i = 0; i < 900; i++) {
    const image = {
      ...catalogue.images[1],
      id: `extra-${i}`,
      asset: `extra-${i}-${sha256}.img`,
      revision: sha256,
      sha256,
      geometry: "ibm3740",
      byteLength: shared.length,
      license: "x".repeat(4096),
    };
    catalogue.images.push(image);
    provenance.images.push({
      asset: image.asset,
      bytes: image.byteLength,
      sha256,
    });
    input.assets.set(image.asset, shared);
  }
  input.catalogueBytes = json(catalogue);
  input.provenanceBytes = json(provenance);
  let reads = 0;
  input.assets.get = () => {
    reads++;
    throw new Error("unexpected payload read");
  };
  assert.throws(() => capture(input), /metadata exceeds bound/);
  assert.equal(reads, 0);
});

test("deduplicated admission outputs still validate every supplied logical alias", () => {
  for (const body of [
    undefined,
    new Uint8Array(1),
    new Uint8Array(256).fill(99),
  ]) {
    const input = fixture(),
      envelope = JSON.parse(input.admissionBytes);
    envelope.assets.push({
      ...envelope.assets[1],
      path: "bootstrap-alias.bin",
    });
    input.admissionBytes = json(envelope);
    if (body) input.assets.set("bootstrap-alias.bin", body);
    assert.throws(
      () => capture(input),
      /byte payload required|planned asset differs/,
    );
  }
  const input = fixture(),
    envelope = JSON.parse(input.admissionBytes);
  envelope.assets.push({ ...envelope.assets[1], path: "bootstrap-alias.bin" });
  input.admissionBytes = json(envelope);
  input.assets.set(
    "bootstrap-alias.bin",
    input.assets.get(envelope.assets[1].path),
  );
  const result = capture(input),
    bindings = result.manifest.admissions[0].bindings;
  assert.equal(bindings[1].asset, bindings[2].asset);
  assert.equal(
    result.manifest.assets.filter((row) => row.path === bindings[1].asset)
      .length,
    1,
  );
});
