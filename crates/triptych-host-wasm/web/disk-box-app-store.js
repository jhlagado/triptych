// Explicit adapter for the existing Files/archives workspace. Its byte snapshots
// are views, never the database authority. Published mounts and ejected personal
// disks remain in the disk-box manifest across every view checkpoint/commit.
import { openDiskBoxStore } from "./disk-box-store.js";
import {
  validateDiskBoxManifest,
  prepareDiskBoxCheckpoint,
} from "./disk-box.js";
import { resolveDiskBoxConfiguration } from "./disk-box-runtime.js";
import { prepareSavedMachineAdoption } from "./disk-box-adoption.js";
import { copySavedMachine, sameSavedMachine } from "./saved-machine.js";
import { createWorkspaceCoordinator } from "./disk-workspace.js";
import {
  validateDiskCatalogue,
  publishedImageReference,
} from "./disk-catalogue.js";
import { launchRecipeDigest, prepareDiskLaunch } from "./disk-launch.js";
import {
  resolveDiskLibraryRecipe,
  resolveDiskLibraryAdmission,
} from "./disk-library-registry.js";

export async function prepareDiskBoxRecipeLaunch(
  value,
  resolved,
  options = {},
) {
  const manifest = validateDiskBoxManifest(value);
  const reuse =
    options.freshInstance !== true &&
    manifest.recipeSelections.some(
      (selection) => selection.recipeDigest === resolved.digest,
    );
  return prepareDiskLaunch(
    manifest,
    reuse
      ? { descriptor: resolved.descriptor, digest: resolved.digest }
      : await resolved.materialize(),
    options,
  );
}

// Runtime admission follows the retained recovery binding, not a temporary A
// mount or this release's default profile. No disk or bootstrap is fetched.
export async function diskBoxRuntimeDeployment(
  value,
  {
    registry,
    deployment,
    crypto = globalThis.crypto,
    resolveRecipe = resolveDiskLibraryRecipe,
    resolveAdmission = resolveDiskLibraryAdmission,
  } = {},
) {
  const manifest = validateDiskBoxManifest(value);
  const configuration = manifest.configurations.find(
    (item) => item.id === manifest.selectedConfigurationId,
  );
  if (configuration.systemDisk.kind !== "published") return deployment;
  const image = configuration.systemDisk.image;
  const bootstrapSha256 = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        Uint8Array.from(configuration.bootstrap.bytes),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const query = {
    image: { id: image.id, revision: image.revision, sha256: image.sha256 },
    configuredCount: configuration.configuredCount,
    bootstrapSha256,
  };
  const instance = manifest.launchInstances.find(
    (item) => item.configurationId === configuration.id,
  );
  if (instance) {
    for (const recipe of registry.metadata.recipes.filter(
      (item) =>
        item.configuredCount === query.configuredCount &&
        item.slots[0]?.kind === "published" &&
        item.slots[0].image.id === image.id &&
        item.slots[0].image.revision === image.revision,
    )) {
      const resolved = await resolveRecipe(registry, {
        id: recipe.id,
        revision: recipe.revision,
      });
      if (
        resolved.digest === instance.recipeDigest &&
        resolved.descriptor.bootstrap.sha256 === bootstrapSha256 &&
        resolved.descriptor.slots[0].image.sha256 === image.sha256
      )
        return resolved.admission;
    }
  }
  return (await resolveAdmission(registry, query)).admission;
}

const hash = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const media = (snapshot) =>
  snapshot.schema
    ? snapshot.slots
    : snapshot.bootstrap.profile === "triptych-cpu-v0.1-8m-ab"
      ? [snapshot.drives.A, snapshot.drives.B]
      : [snapshot.drives.A];

// A disk-box view can represent temporary A ejection. Historical archive
// validators deliberately cannot; never export this view as a bootable archive.
export function copyDiskBoxView(value) {
  const fields = Object.getOwnPropertyDescriptors(value ?? {});
  const first = Array.isArray(fields.slots?.value)
    ? Object.getOwnPropertyDescriptor(fields.slots.value, "0")
    : undefined;
  if (fields.schema?.value !== "triptych-drive-set-v4" || first?.value !== null)
    return copySavedMachine(value);
  const names = ["schema", "configuredCount", "bootstrap", "slots"];
  if (
    Reflect.ownKeys(fields).length !== names.length ||
    names.some((name) => !fields[name] || !Object.hasOwn(fields[name], "value"))
  )
    throw new Error("Invalid disk-box view fields.");
  const input = fields.slots.value;
  if (
    !Array.isArray(input) ||
    input.length < 1 ||
    input.length > 16 ||
    Reflect.ownKeys(input).length !== input.length + 1
  )
    throw new Error("Invalid disk-box view slots.");
  const ownedFields = Array.from({ length: input.length }, (_, index) => {
    const field = Object.getOwnPropertyDescriptor(input, index);
    if (!field || !Object.hasOwn(field, "value"))
      throw new Error("Invalid disk-box view slot.");
    return field.value;
  });
  const ids = new Set(
    ownedFields
      .filter(Boolean)
      .map(
        (slot) => Object.getOwnPropertyDescriptor(slot, "instanceId")?.value,
      ),
  );
  let nonce = 0,
    id;
  do {
    id = "00000000-0000-4000-8000-" + String(nonce++).padStart(12, "0");
  } while (ids.has(id));
  // Reuse the exact closed v4 validator for all remaining fields. This private
  // carrier exists only during validation, is removed synchronously, and is
  // never installed, hashed, stored or returned as media.
  ownedFields[0] = {
    instanceId: id,
    name: "view-validation",
    bytes: new Uint8Array(2097152),
  };
  const copied = copySavedMachine({
    schema: fields.schema.value,
    configuredCount: fields.configuredCount.value,
    bootstrap: fields.bootstrap.value,
    slots: ownedFields,
  });
  copied.slots[0] = null;
  return copied;
}

export function sameDiskBoxView(left, right) {
  const a = copyDiskBoxView(left),
    b = copyDiskBoxView(right);
  if (!a.schema || !b.schema) return sameSavedMachine(a, b);
  const bytesEqual = (x, y) =>
    x.length === y.length && x.every((byte, index) => byte === y[index]);
  return (
    a.configuredCount === b.configuredCount &&
    a.bootstrap.profile === b.bootstrap.profile &&
    bytesEqual(a.bootstrap.bytes, b.bootstrap.bytes) &&
    a.slots.every((slot, index) => {
      const other = b.slots[index];
      return slot === null || other === null
        ? slot === other
        : slot.instanceId === other.instanceId &&
            slot.name === other.name &&
            bytesEqual(slot.bytes, other.bytes);
    })
  );
}

export function diskBoxViewSlotWritable(
  configuration,
  current,
  candidate,
  index,
) {
  const image = media(candidate)?.[index];
  if (!image) return false;
  let sourceIndex = index;
  if (candidate.schema && current?.schema) {
    sourceIndex = current.slots.findIndex(
      (slot) => slot?.instanceId === image.instanceId,
    );
    // A freshly created/copied private UUID is not a protected source mount.
    if (sourceIndex < 0) return true;
  }
  const binding = configuration.slots[sourceIndex];
  return !binding || (binding.kind === "personal" && binding.writable);
}

export async function openDiskBoxAppStore(options) {
  const authority = await openDiskBoxStore(options);
  let head;
  let headGeneration = 0;
  const viewIds = new Map(),
    imageCache = new Map();
  function viewId(config, index, binding) {
    if (binding.kind === "personal") return binding.diskId;
    const key = `${config.id}:${index}:${binding.image.sha256}`;
    if (!viewIds.has(key)) viewIds.set(key, crypto.randomUUID());
    return viewIds.get(key);
  }
  async function snapshotFor(manifest, newBlobs = new Map()) {
    const config = manifest.configurations.find(
      (item) => item.id === manifest.selectedConfigurationId,
    );
    if (!config) throw new Error("No selected disk-box configuration.");
    const resolved = await resolveDiskBoxConfiguration({
      manifest,
      configurationId: config.id,
      readPersonalDisk: async (id) => {
        const disk = manifest.personalDisks.find((item) => item.id === id);
        if (newBlobs.has(disk.content.sha256))
          return newBlobs.get(disk.content.sha256);
        const blob = await authority.readRawRecovery(
          "disk-box-blobs-v1",
          disk.content.sha256,
        );
        if (!blob?.bytes)
          throw new Error("Missing personal image; use raw recovery.");
        return blob.bytes;
      },
      fetchImage: async (image) => {
        const key = image.url + image.sha256;
        if (!imageCache.has(key)) {
          const { fetchPublishedImage } = await import("./disk-catalogue.js");
          imageCache.set(key, await fetchPublishedImage(image));
        }
        return imageCache.get(key);
      },
    });
    const slots = resolved.slots.map((slot, index) =>
      slot === null
        ? null
        : {
            instanceId: viewId(config, index, slot.binding),
            name: slot.name,
            bytes: slot.bytes,
          },
    );
    if (/^triptych-cpu-v0.1-2m-n/.test(config.bootstrap.profile))
      return {
        schema: "triptych-drive-set-v4",
        configuredCount: config.configuredCount,
        bootstrap: resolved.bootstrap,
        slots,
      };
    const legacy = (slot) =>
      slot === null ? null : { name: slot.name, bytes: slot.bytes };
    return {
      bootstrap: resolved.bootstrap,
      drives: { A: legacy(slots[0]), B: legacy(slots[1] ?? null) },
    };
  }
  async function load() {
    const generation = ++headGeneration;
    const loaded = await authority.load();
    if (generation !== headGeneration)
      return {
        kind: "recovery",
        error: "Disk-box read superseded by a newer operation.",
      };
    if (loaded.kind !== "ready") {
      head = loaded;
      return loaded;
    }
    try {
      const snapshot = await snapshotFor(loaded.manifest);
      const raw = await authority.readRawRecovery("disk-box-state-v1", "head");
      if (
        generation !== headGeneration ||
        !raw ||
        raw.digest !== loaded.token.digest
      )
        throw new Error("Disk-box authority changed while reading.");
      head = loaded;
      return {
        ...loaded,
        snapshot,
        receipt: {
          revision: raw.revision,
          digest: raw.digest,
          operationId: raw.operationId,
        },
      };
    } catch (error) {
      return { kind: "recovery", error: error.message };
    }
  }
  function config() {
    if (head?.kind !== "ready") throw new Error("Disk box is not active.");
    return head.manifest.configurations.find(
      (item) => item.id === head.manifest.selectedConfigurationId,
    );
  }
  async function prepareView(value, checkpoint = false) {
    if (head?.kind !== "ready") throw new Error("Disk box is not active.");
    const baseline = validateDiskBoxManifest(head.manifest);
    const snapshot = copyDiskBoxView(value),
      current = baseline.configurations.find(
        (item) => item.id === baseline.selectedConfigurationId,
      );
    const original = await snapshotFor(baseline),
      oldSlots = media(original),
      nextSlots = media(snapshot);
    if (
      checkpoint &&
      (!same(snapshot.bootstrap, original.bootstrap) ||
        nextSlots.length !== oldSlots.length)
    )
      throw new Error("Checkpoint cannot reconfigure media.");
    const hashes = await Promise.all(
      nextSlots.map((slot) => (slot ? hash(slot.bytes) : null)),
    );
    const updates = new Map();
    for (let i = 0; i < oldSlots.length; i++) {
      const binding = current.slots[i],
        old = oldSlots[i],
        next = nextSlots[i];
      const retained =
        old && next && (!snapshot.schema || old.instanceId === next.instanceId);
      if (
        binding &&
        retained &&
        (binding.kind === "published" || !binding.writable)
      ) {
        const expected =
          binding.kind === "published"
            ? binding.image.sha256
            : baseline.personalDisks.find((disk) => disk.id === binding.diskId)
                .content.sha256;
        if (hashes[i] !== expected || old.name !== next.name)
          throw new Error(
            "Protected disk cannot be modified. Make an explicit writable copy first.",
          );
      }
      if (checkpoint) {
        if (!!old !== !!next || (old && !retained))
          throw new Error("Checkpoint cannot change disk bindings.");
        if (binding?.kind === "personal" && binding.writable)
          updates.set(binding.diskId, next.bytes);
      }
    }
    if (checkpoint)
      return {
        ...(await prepareDiskBoxCheckpoint(baseline, current.id, updates)),
        slotWritable: current.slots.map(
          (slot) => slot?.kind === "personal" && slot.writable,
        ),
      };
    if (snapshot.schema && snapshot.slots[0] === null)
      throw new Error(
        "Restore system A before archive-based management; use the disk box for live mount changes.",
      );
    const adopted = await prepareSavedMachineAdoption(snapshot, {
      configurationId: current.id,
      name: current.name,
      createDiskId: () => crypto.randomUUID(),
    });
    const proposed = adopted.manifest.configurations[0];
    const manifest = baseline,
      newBlobs = new Map();
    for (let i = 0; i < nextSlots.length; i++) {
      const next = nextSlots[i];
      if (!next) continue;
      const old = oldSlots[i],
        binding = current.slots[i];
      const retained =
        old && (!snapshot.schema || next.instanceId === old.instanceId);
      if (
        retained &&
        binding &&
        hashes[i] ===
          (binding.kind === "published"
            ? binding.image.sha256
            : manifest.personalDisks.find((disk) => disk.id === binding.diskId)
                .content.sha256)
      ) {
        proposed.slots[i] = binding;
        continue;
      }
      const candidate = adopted.manifest.personalDisks.find(
        (disk) => disk.id === proposed.slots[i].diskId,
      );
      if (retained && binding?.kind === "personal")
        candidate.id = binding.diskId;
      const existing = manifest.personalDisks.findIndex(
        (disk) => disk.id === candidate.id,
      );
      if (
        existing >= 0 &&
        manifest.personalDisks[existing].geometry !== candidate.geometry
      )
        candidate.id = crypto.randomUUID();
      const target = manifest.personalDisks.findIndex(
        (disk) => disk.id === candidate.id,
      );
      if (target >= 0) manifest.personalDisks[target] = candidate;
      else manifest.personalDisks.push(candidate);
      proposed.slots[i] = {
        kind: "personal",
        diskId: candidate.id,
        writable: true,
      };
      newBlobs.set(candidate.content.sha256, next.bytes);
    }
    // A data mount is not authority to replace the retained boot/recovery disk.
    proposed.systemDisk = same(snapshot.bootstrap, original.bootstrap)
      ? current.systemDisk
      : proposed.slots[0];
    manifest.configurations[
      manifest.configurations.findIndex((item) => item.id === current.id)
    ] = proposed;
    return {
      manifest: validateDiskBoxManifest(manifest),
      newBlobs,
      slotWritable: proposed.slots.map(
        (slot) => slot?.kind === "personal" && slot.writable,
      ),
    };
  }
  async function publish(expected, id, snapshot, checkpoint) {
    const candidate = await prepareView(snapshot, checkpoint);
    const result = await authority[
      checkpoint ? "saveCheckpoint" : "commitChange"
    ](expected, id, candidate.manifest, candidate.newBlobs);
    if (result.status !== "committed")
      throw new Error(
        "This change was superseded; reload the current disk box.",
      );
    ++headGeneration;
    head = { kind: "ready", manifest: candidate.manifest, token: result.token };
    return { token: result.token, receipt: result.receipt };
  }
  return {
    authority,
    load,
    prepareView,
    snapshotFor,
    get head() {
      return head;
    },
    get configuration() {
      return config();
    },
    get slotWritable() {
      return config().slots.map(
        (slot) => slot?.kind === "personal" && slot.writable,
      );
    },
    saveCheckpoint: (token, snapshot) =>
      publish(token, crypto.randomUUID(), snapshot, true),
    commitChange: (token, id, snapshot) => publish(token, id, snapshot, false),
    readRawRecovery: (...args) => authority.readRawRecovery(...args),
    readRawRecords: (...args) => authority.readRawRecords(...args),
    readRawSnapshot: () => authority.readRawSnapshot(),
    listBackups: () => authority.listBackups(),
    async readBackup(id) {
      const value = await authority.readBackup(id);
      return value?.schema === "triptych-disk-box-v1"
        ? snapshotFor(value)
        : value;
    },
    close: () => authority.close(),
  };
}

function token(value) {
  if (
    value?.kind !== "disk-box" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(value.digest)
  )
    throw new Error("Invalid disk-box view token.");
  return { kind: "disk-box", revision: value.revision, digest: value.digest };
}
function publication(value) {
  const copied = token(value.token),
    receipt = value.receipt;
  if (
    receipt?.revision !== copied.revision ||
    receipt.digest !== copied.digest ||
    typeof receipt.operationId !== "string"
  )
    throw new Error("Disk-box publication does not match its receipt.");
  return {
    token: copied,
    receipt: {
      revision: receipt.revision,
      digest: receipt.digest,
      operationId: receipt.operationId,
    },
  };
}
export function createDiskBoxArchiveWorkspace(options) {
  return createWorkspaceCoordinator(options, {
    copySnapshot: copyDiskBoxView,
    sameSnapshot: sameDiskBoxView,
    copyToken: token,
    copyReceipt: (value) => ({ ...value }),
    savedHead: (value) => ({
      ...publication(value),
      snapshot: copyDiskBoxView(value.snapshot),
    }),
    publication,
    checkpointResult: (value) => ({ kind: "saved", ...publication(value) }),
    commitResult: publication,
    captureAfterDrain: true,
  });
}

export async function starterRecipe(
  deployment,
  CpmDisk,
  { libraryOnly = false, loadAssets = true } = {},
) {
  const selected = deployment.twoMibProfiles.find(
    (item) => item.configuredCount === 4,
  );
  if (!selected) throw new Error("Four-drive profile unavailable.");
  const tuple = {
    residentProfile: selected.residentProfile,
    bootstrap: {
      asset: selected.bootstrap.asset,
      sha256: selected.bootstrap.sha256,
    },
  };
  const response = await fetch("disk-catalogue.json", {
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Published disk catalogue unavailable.");
  const catalogue = validateDiskCatalogue(await response.json());
  const image = (id) => {
    const item = catalogue.images.find((entry) => entry.id === id);
    if (!item) throw new Error("Published starter missing.");
    return publishedImageReference(catalogue, id, item.revision, location.href);
  };
  // Immutable canonical blank seed: 16,384 zero system bytes followed by E5
  // to 2 MiB (CpmImage::blank Triptych2M). Metadata previews do not create it.
  const seedHash =
    "f6dd864da86d9f7fe5e6576598e42c6f06e20ad46ca17674685a446fa368a1ce";
  const profile = tuple.residentProfile;
  const role = (name) => ({
    kind: "writable-role",
    role: name,
    name: name === "work" ? "Work" : "Saves",
    geometry: "triptych-cpm-2m-v1",
    seed: { sha256: seedHash, byteLength: 2097152, systemProfile: null },
  });
  const descriptor = {
    schema: "triptych-launch-recipe-v1",
    id: libraryOnly ? "library" : "starter",
    revision: "content",
    name: libraryOnly
      ? "Protected library only"
      : "Tools, games and personal disks",
    configuredCount: 4,
    bootstrap: { profile, sha256: tuple.bootstrap.sha256, byteLength: 256 },
    slots: [
      { kind: "published", image: image("system-2m-n04") },
      libraryOnly ? null : role("work"),
      { kind: "published", image: image("games-2m") },
      libraryOnly ? null : role("saves"),
    ],
  };
  descriptor.revision = await launchRecipeDigest(descriptor);
  const digest = await launchRecipeDigest(descriptor);
  if (!loadAssets) return { descriptor, digest };
  const boot = await fetch(tuple.bootstrap.asset, {
    cache: "no-store",
    redirect: "error",
  });
  if (!boot.ok) throw new Error("Starter bootstrap unavailable.");
  const bootstrapBytes = new Uint8Array(await boot.arrayBuffer());
  let seed;
  if (!libraryOnly) {
    const disk = CpmDisk.create_two_mib();
    try {
      seed = disk.export_source();
    } finally {
      disk.free();
    }
    if ((await hash(seed)) !== seedHash)
      throw new Error(
        "Canonical blank seed changed; a new recipe revision is required.",
      );
  }
  return {
    descriptor,
    digest,
    bootstrapBytes,
    seedBytes: new Map(
      libraryOnly
        ? []
        : [
            ["work", seed],
            ["saves", seed],
          ],
    ),
  };
}

export { prepareDiskLaunch };
