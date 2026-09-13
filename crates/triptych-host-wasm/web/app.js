import init, { TriptychCpu, CpmDisk } from "./triptych_host_wasm.js";
import {
  inputTypeToBytes,
  keyEventToBytes,
  renderTerminal,
  revealTerminalCursor,
  TerminalBuffer,
  textInputToBytes,
} from "./terminal.js";
import { acquireDiskWriter } from "./disk-workspace.js";
import { loadDirectLaunch } from "./direct-launch.js";
import {
  openDiskBoxAppStore,
  createDiskBoxArchiveWorkspace,
  diskBoxRuntimeDeployment,
  prepareDiskBoxRecipeLaunch,
  copyDiskBoxView,
  sameDiskBoxView,
  diskBoxViewSlotWritable,
} from "./disk-box-app-store.js";
import {
  loadDiskLibraryRegistry,
  resolveDiskLibraryRecipe,
} from "./disk-library-registry.js";
import { publishedImageReference } from "./disk-catalogue.js";
import { prepareSavedMachineAdoption } from "./disk-box-adoption.js";
import { emptyDiskBox } from "./disk-box.js";
import { prepareDiskBoxMediaChange } from "./disk-box-media-change.js";
import { encodeDiskBoxRecovery } from "./disk-box-recovery.js";
import { prepareSavedMachineRuntime } from "./saved-machine-runtime.js";
import {
  copySavedMachine,
  encodeSavedMachine,
  decodeSavedMachineArchive,
} from "./saved-machine.js";
import { prepareTwoMibConfiguration } from "./saved-machine-configuration.js";
import { fetchTwoMibSystem } from "./two-mib-system.js";
import { fetchPublicDriveSet } from "./public-distribution.js";
import { prepareSourceBundle, mapSourceBundleOffset } from "./source-bundle.js";
import {
  fetchLargeDiskSystem,
  fetchLargeAbDiskSystem,
} from "./disk-profile.js";
import {
  validateToolCatalog,
  identifyInstalledTools,
  fetchToolUpdates,
} from "./tool-catalog.js";

const CCP_SYSTEM_OFFSET = 0x0000;
const BDOS_SYSTEM_OFFSET = 0x0800;
const BIOS_SYSTEM_OFFSET = 0x1600;
const BACKING_SECTOR_BYTES = 512;
const MAX_SERIAL_INPUT_BYTES = 16 * 1024;

const terminalElement = document.querySelector("#terminal");
const statusElement = document.querySelector("#status");
const saveStatusElement = document.querySelector("#save-status");
const diskInput = document.querySelector("#disk-input");
const resetButton = document.querySelector("#reset");
const downloadButton = document.querySelector("#download");
const mobileInput = document.querySelector("#mobile-terminal-input");
const showKeyboardButton = document.querySelector("#show-keyboard");
const controlKeyButton = document.querySelector("#terminal-control-key");
const mobileKeyButtons = document.querySelectorAll("[data-terminal-key]");
const terminal = new TerminalBuffer();
const libraryView = document.querySelector("#library-view");
const machineHeader = document.querySelector("main > header");
const terminalShell = document.querySelector(".terminal-shell");
const mobileControls = document.querySelector(".mobile-terminal-controls");
const initialRoute = new URL(location.href).searchParams;
const directLaunchId = initialRoute.has("disk")
  ? initialRoute.get("disk")
  : undefined;
if (directLaunchId !== undefined) {
  document.body.classList.add("direct-launch");
  document.querySelector("#open-library").hidden = true;
  document.querySelector("#files").hidden = true;
  document.querySelector("#retry-save").hidden = true;
  saveStatusElement.hidden = true;
}

function showLibraryView({ updateAddress = true } = {}) {
  if (directLaunchId !== undefined) return;
  machineHeader.hidden = true;
  terminalShell.hidden = true;
  mobileControls.hidden = true;
  libraryView.hidden = false;
  document.body.classList.add("library-open");
  if (updateAddress && location.hash !== "#library")
    history.pushState(
      null,
      "",
      `${location.pathname}${location.search}#library`,
    );
  document.querySelector("#close-library").focus({ preventScroll: true });
}

function showComputerView({ updateAddress = true } = {}) {
  libraryView.hidden = true;
  machineHeader.hidden = false;
  terminalShell.hidden = false;
  mobileControls.hidden = false;
  document.body.classList.remove("library-open");
  if (updateAddress && location.hash)
    history.pushState(null, "", `${location.pathname}${location.search}`);
  terminalElement.focus({ preventScroll: true });
}

function showAddressedView() {
  if (directLaunchId !== undefined) showComputerView({ updateAddress: false });
  else if (location.hash === "#library")
    showLibraryView({ updateAddress: false });
  else showComputerView({ updateAddress: false });
}

document
  .querySelector("#open-library")
  .addEventListener("click", () => showLibraryView());
document
  .querySelector("#close-library")
  .addEventListener("click", () => showComputerView());
window.addEventListener("popstate", showAddressedView);
window.addEventListener("hashchange", showAddressedView);
showAddressedView();

// A second, explicitly selected machine lets returning visitors play the
// published starter disks without replacing their existing working machine.
// This stable namespace persists game saves across visits and tool releases.
const suppliedMachine = initialRoute.get("machine") === "supplied";
const storageName = suppliedMachine ? "triptych-supplied" : "triptych-cpu";
const startFreshMarker = "triptych:start-fresh-in-progress:v1";
function localConfigurationSelection(route) {
  if (!route.has("configuration")) return undefined;
  if (
    route.has("recipe") ||
    route.has("revision") ||
    route.getAll("configuration").length !== 1
  )
    throw new Error(
      "Choose either a device-local configuration or a public recipe, not both.",
    );
  const id = route.get("configuration");
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)
  )
    throw new Error("Invalid device-local configuration identifier.");
  return id;
}
function localConfigurationBookmark(id) {
  const query = new URLSearchParams();
  if (suppliedMachine) query.set("machine", "supplied");
  query.set("configuration", id);
  return "?" + query.toString();
}
document.querySelector("#machine-choice").textContent = suppliedMachine
  ? "Supplied A+B machine — its saves are separate from your usual machine."
  : "Your working machine — existing saved disks are preserved.";

let machine;
let runtime;
let startupRuntime;
let bootRom;
let ccp;
let bdos;
let bios;
let activeMedia;
let selectedDrive = "A";
let runGeneration = 0;
let controlPending = false;
let machineRunning = false;
let workspace;
let store;
let writer;
let committed;
let committedGeneration = 0;
let lastFlushCounts = [0, 0];
let saveRequest = 0;
let managementToken;
let stagedSet;
let panelGeneration = 0;
let stageGeneration = 0;
let managementAttempt = 0;
let diagnosticAttempt = 0;
let catalog;
let deployment;
let libraryRegistry;
let requestedRecipe;
let directSession = false;
let directInstruction = "";
let recipePreviewGeneration = 0;

function canRunMachine() {
  return directSession || !!workspace?.canRun;
}
async function registry() {
  libraryRegistry ??= loadDiskLibraryRegistry({ baseUrl: document.baseURI });
  try {
    return await libraryRegistry;
  } catch (error) {
    libraryRegistry = undefined;
    throw error;
  }
}
async function libraryRecipe(id) {
  if (requestedRecipe?.reference.id === id) return requestedRecipe;
  return resolveDiskLibraryRecipe(await registry(), { default: id });
}
async function previewRequestedRecipe(reference) {
  const generation = ++recipePreviewGeneration;
  let recipe;
  try {
    recipe = await resolveDiskLibraryRecipe(await registry(), reference);
  } catch (error) {
    if (generation !== recipePreviewGeneration) return;
    throw error;
  }
  if (generation !== recipePreviewGeneration) return;
  requestedRecipe = recipe;
  document.querySelector("#requested-recipe-preview").hidden = false;
  document.querySelector("#ready-made-machines").open = true;
  document.querySelector("#requested-recipe-description").textContent =
    `${recipe.descriptor.name}. Review it here, then choose Use this setup. Your other machines and data disks will be kept.`;
  showLibraryView();
  libraryStatus.textContent = "A shared setup is ready to use.";
}

// A preview must not unload a running machine or interrupt queued disk saves.
// Keep ordinary hrefs for sharing and native modified/new-tab clicks. Only the
// explicit activation action pauses, checkpoints and restarts this machine.
for (const id of ["share-starter", "share-library", "share-colossal-cave"])
  document.querySelector("#" + id).addEventListener("click", (event) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    const target = new URL(event.currentTarget.href);
    void previewRequestedRecipe({
      id: target.searchParams.get("recipe"),
      revision: target.searchParams.get("revision"),
    }).catch(libraryError);
  });
async function runtimeDeployment(manifest) {
  const configuration = manifest.configurations.find(
    (item) => item.id === manifest.selectedConfigurationId,
  );
  if (configuration.systemDisk.kind === "published")
    return diskBoxRuntimeDeployment(manifest, { registry: await registry() });
  if (
    configuration.bootstrap.profile.startsWith("triptych-cpu-v0.1-2m-") &&
    !deployment
  )
    await loadDeployment();
  return deployment;
}
let displayedGeometry;
let migrationPending = false;
const filesDialog = document.querySelector("#files-dialog");
const filesButton = document.querySelector("#files");
const filesStatus = document.querySelector("#files-status");
const fileList = document.querySelector("#file-list");
const backupList = document.querySelector("#backup-list");
const toolsList = document.querySelector("#tool-list");
const beginButton = document.querySelector("#begin-management");
const commitButton = document.querySelector("#commit-disk");
const cancelButton = document.querySelector("#cancel-management");
const importInput = document.querySelector("#file-import");
const savedAcknowledgment = document.querySelector("#saved-and-exited");
const recoveryButton = document.querySelector("#begin-recovery");
const discardAcknowledgment = document.querySelector("#discard-volatile");
const recoveryDownload = document.querySelector("#download-recovery");
const retrySave = document.querySelector("#retry-save");
const prepareBuildButton = document.querySelector("#prepare-build");
const starterButton = document.querySelector("#stage-adventure");
const migrateButton = document.querySelector("#migrate-large-disk");
const driveSelect = document.querySelector("#file-drive");
const enableAbButton = document.querySelector("#enable-ab");
const blankBButton = document.querySelector("#blank-b");
const removeBButton = document.querySelector("#remove-b");
const setInput = document.querySelector("#drive-set-input");
const downloadSetButton = document.querySelector("#download-set");
const downloadCheckpointSetButton = document.querySelector(
  "#download-checkpoint-set",
);
const slotCount = document.querySelector("#configured-count");
const configureButton = document.querySelector("#configure-drives");
const blankDriveButton = document.querySelector("#blank-drive");
const ejectDriveButton = document.querySelector("#eject-drive");
for (let index = 2; index < 16; index++) {
  const option = document.createElement("option");
  option.value = option.textContent = String.fromCharCode(65 + index);
  driveSelect.append(option);
}

function driveIndex(letter = selectedDrive) {
  if (!/^[A-P]$/.test(letter)) throw new Error("Select a drive from A to P.");
  return letter.charCodeAt(0) - 65;
}
function slots(snapshot) {
  if (!snapshot) return [];
  return snapshot.schema === "triptych-drive-set-v4"
    ? snapshot.slots
    : [snapshot.drives.A, snapshot.drives.B];
}
function imageAt(snapshot, letter = selectedDrive) {
  return slots(snapshot)[driveIndex(letter)];
}
function replaceImage(snapshot, letter, image) {
  if (snapshot.schema === "triptych-drive-set-v4") {
    const index = driveIndex(letter);
    if (index >= snapshot.configuredCount)
      throw new Error("Drive is outside the configured slots.");
    snapshot.slots[index] = image;
  } else {
    if (!["A", "B"].includes(letter))
      throw new Error("This historical profile supports A/B only.");
    snapshot.drives[letter] = image;
  }
}

function displayedSet() {
  return managementToken
    ? workspace.inspect(managementToken).snapshot
    : committed?.snapshot;
}
function selectedImage(snapshot) {
  const image = imageAt(snapshot);
  if (!image) throw new Error(`Drive ${selectedDrive} is not attached.`);
  return image;
}
function captureCheckpoint() {
  if (!runtime) throw new Error("No running drive set is available.");
  return runtime.captureCheckpoint();
}
function stageSet(token, snapshot) {
  workspace.stage(token, snapshot);
  stagedSet = copySavedMachine(snapshot);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function controls() {
  const running = machineRunning && canRunMachine();
  resetButton.disabled = !running || filesDialog.open;
  downloadButton.disabled = !imageAt(committed?.snapshot);
  downloadButton.textContent = `Download saved disk ${selectedDrive}`;
  downloadSetButton.disabled = !committed;
  recoveryDownload.disabled = !machine || !activeMedia?.slots[driveIndex()];
  downloadCheckpointSetButton.disabled = !machine;
  const managing = workspace?.state === "managing";
  beginButton.disabled =
    !running || !writer?.owned || !savedAcknowledgment.checked;
  recoveryButton.disabled =
    workspace?.state !== "running" ||
    !writer?.owned ||
    !discardAcknowledgment.checked;
  const snapshot = stagedSet ?? displayedSet();
  const attached = !!imageAt(snapshot);
  const protectedSlot =
    store?.head?.kind === "ready" &&
    snapshot &&
    !diskBoxViewSlotWritable(
      store.configuration,
      committed?.snapshot,
      snapshot,
      driveIndex(),
    );
  const isTwoMib = snapshot?.schema === "triptych-drive-set-v4";
  const count = isTwoMib ? snapshot.configuredCount : 2;
  for (const option of driveSelect.options)
    option.disabled = driveIndex(option.value) >= count;
  configureButton.disabled =
    !managing || !!stagedSet || migrationPending || !deployment?.twoMibProfiles;
  slotCount.disabled = !managing || !!stagedSet || migrationPending;
  blankDriveButton.disabled =
    !managing || !isTwoMib || attached || driveIndex() >= count;
  ejectDriveButton.disabled =
    !managing || !isTwoMib || !attached || selectedDrive === "A";
  importInput.disabled = !managing || !attached || protectedSlot;
  diskInput.disabled = !managing;
  setInput.disabled = !managing;
  prepareBuildButton.disabled = !managing || !attached || protectedSlot;
  starterButton.disabled =
    !managing || !deployment || !attached || protectedSlot;
  migrateButton.disabled =
    !managing ||
    !!stagedSet ||
    migrationPending ||
    selectedDrive !== "A" ||
    snapshot?.bootstrap.profile === "triptych-cpu-v0.1-8m-ab" ||
    displayedGeometry !== "ibm3740" ||
    !deployment?.diskProfiles;
  enableAbButton.disabled =
    !managing ||
    isTwoMib ||
    !!stagedSet ||
    migrationPending ||
    !deployment?.diskProfiles ||
    snapshot?.bootstrap.profile === "triptych-cpu-v0.1-8m-ab";
  blankBButton.disabled =
    !managing ||
    snapshot?.bootstrap.profile !== "triptych-cpu-v0.1-8m-ab" ||
    !!imageAt(snapshot, "B");
  removeBButton.disabled = !managing || isTwoMib || !imageAt(snapshot, "B");
  commitButton.disabled =
    !managementToken ||
    !stagedSet ||
    !["managing", "recovery"].includes(workspace?.state);
  cancelButton.disabled =
    !managementToken || !["managing", "preparing"].includes(workspace?.state);
  for (const button of toolsList.querySelectorAll("button"))
    button.disabled = !managing || protectedSlot;
  for (const button of backupList.querySelectorAll("[data-restore]"))
    button.disabled = !managing;
}

function saveFailed(error) {
  setSaveStatus(
    `Browser storage failed: ${message(error)}. Download latest checkpoint for recovery.`,
    "error",
  );
  retrySave.hidden = false;
}

// The coordinator bounds the queue and distinguishes a persisted checkpoint
// from a superseded pending submission. Both drive snapshots are captured in
// this synchronous call; no guest slice can run between their exports.
async function saveCheckpoint() {
  if (!workspace?.canRun || !writer?.owned) return;
  const request = ++saveRequest;
  setSaveStatus("Saving…", "saving");
  try {
    const result = await workspace.saveCheckpoint(captureCheckpoint());
    if (result.kind === "superseded" || request !== saveRequest) return;
    retrySave.hidden = true;
    setSaveStatus("Saved in this browser", "saved");
  } catch (error) {
    if (request === saveRequest) saveFailed(error);
  } finally {
    controls();
  }
}

// The layout viewport is inconsistent across mobile browsers once the software
// keyboard opens. VisualViewport is the space the user can actually see.
function syncVisualViewport() {
  const viewport = window.visualViewport;
  // Some mobile engines briefly retain the old VisualViewport dimensions
  // while the layout viewport has already contracted. The smaller value is
  // the only area that is certainly visible in both states.
  const height = Math.min(viewport?.height ?? Infinity, window.innerHeight);
  const width = Math.min(viewport?.width ?? Infinity, window.innerWidth);
  const offsetTop = viewport?.offsetTop ?? 0;
  const offsetLeft = viewport?.offsetLeft ?? 0;
  const style = document.documentElement.style;
  style.setProperty("--visual-viewport-height", `${height}px`);
  style.setProperty("--visual-viewport-width", `${width}px`);
  style.setProperty("--visual-viewport-offset-top", `${offsetTop}px`);
  style.setProperty("--visual-viewport-offset-left", `${offsetLeft}px`);
  requestAnimationFrame(revealActiveCursor);
}

function revealActiveCursor() {
  if (
    !filesDialog.open &&
    (document.activeElement === terminalElement ||
      document.activeElement === mobileInput)
  )
    revealTerminalCursor(terminalElement);
}

function setKeyboardOpen(open) {
  document.body.classList.toggle("terminal-keyboard-open", open);
  showKeyboardButton.textContent = open ? "Done" : "Keyboard";
  showKeyboardButton.setAttribute("aria-pressed", String(open));
  syncVisualViewport();
}

function stopMachine(error) {
  runGeneration += 1;
  machineRunning = false;
  resetButton.disabled = true;
  downloadButton.disabled = machine === undefined;
  setStatus(
    "Machine stopped after a WebAssembly fault. Download remains available for flushed disk data.",
    "error",
  );
  console.error("Triptych WebAssembly machine stopped", error);
}

function enqueueInput(bytes) {
  if (
    !machineRunning ||
    !canRunMachine() ||
    filesDialog.open ||
    bytes.length === 0
  )
    return false;
  try {
    const accepted = machine.enqueue_serial_input(bytes);
    if (accepted) return true;
    setStatus(
      `Input was not sent because its ${bytes.length} bytes exceed the available ${MAX_SERIAL_INPUT_BYTES}-byte terminal queue. The machine is still running.`,
      "error",
    );
    return false;
  } catch (error) {
    stopMachine(error);
    return false;
  }
}

function focusMobileInput() {
  if (filesDialog.open || !canRunMachine() || !machineRunning) return;
  setKeyboardOpen(true);
  mobileInput.focus({ preventScroll: true });
}

function dismissMobileInput() {
  mobileInput.blur();
  terminalElement.focus({ preventScroll: true });
}

function setControlPending(pending) {
  controlPending = pending;
  controlKeyButton.setAttribute("aria-pressed", String(pending));
}

function setStatus(message, state = "idle") {
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

function setSaveStatus(message, state = "idle") {
  saveStatusElement.textContent = message;
  saveStatusElement.dataset.state = state;
}

function drainOutput() {
  const output = machine?.take_serial_output();
  if (output?.length > 0) {
    terminal.write(output);
    return true;
  }
  return false;
}

function runMachine(generation) {
  if (!machineRunning || !canRunMachine() || generation !== runGeneration)
    return;
  try {
    const deadline = performance.now() + 6;
    let outputChanged = false;
    do {
      const reason = machine.run_slice(25_000, 250_000);
      if (reason === 4) {
        const counts = runtime.flushCounts();
        if (counts.some((count, drive) => count !== lastFlushCounts[drive])) {
          lastFlushCounts = counts;
          void saveCheckpoint();
        }
        showSystemRecovery();
        return;
      }
      // A Z80 instruction can emit at most one serial byte. Draining after
      // every bounded slice caps the transient WASM output batch at 25,000
      // bytes even if several slices fit in one animation frame.
      outputChanged = drainOutput() || outputChanged;
    } while (performance.now() < deadline);
    if (outputChanged) {
      renderTerminal(terminalElement, terminal.snapshot());
      revealActiveCursor();
    }
    const counts = runtime.flushCounts();
    if (counts.some((count, drive) => count !== lastFlushCounts[drive])) {
      lastFlushCounts = counts;
      void saveCheckpoint();
    }
  } catch (error) {
    stopMachine(error);
    return;
  }
  requestAnimationFrame(() => runMachine(generation));
}

async function defaultBootstrap() {
  if (!bootRom) {
    const response = await fetch("bootstrap.bin", {
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Could not load bootstrap.bin.");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== 256)
      throw new Error("Invalid default bootstrap length.");
    bootRom = bytes;
  }
  return bootRom;
}

async function loadDeployment() {
  const response = await fetch("deployment-manifest.json", {
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Could not load deployment-manifest.json.");
  deployment = await response.json();
}

async function defaultResidents() {
  await defaultBootstrap();
  if (ccp && bdos && bios) return;
  const values = await Promise.all(
    ["ccp.bin", "bdos.bin", "bios.bin"].map(async (name) => {
      const response = await fetch(name, {
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error(`Could not load ${name}.`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  if (
    values[0].length !== 2048 ||
    values[1].length !== 3584 ||
    values[2].length !== 1024
  )
    throw new Error("Invalid default resident sizes.");
  [ccp, bdos, bios] = values;
}

async function adaptedDisk(source, profile) {
  if (source.length === 2097152) {
    const match = /^triptych-cpu-v0\.1-2m-n(0[1-9]|1[0-6])$/.exec(profile);
    if (!match)
      throw new Error(
        "Configure two-MiB slots before adapting a two-MiB boot disk.",
      );
    const { system } = await fetchTwoMibSystem({
      deployment,
      configuredCount: Number(match[1]),
      baseUrl: document.baseURI,
    });
    const disk = source.slice();
    disk.set(system.subarray(0, 6656));
    return disk;
  }
  if (source.length === 8388608) {
    const system =
      profile === "triptych-cpu-v0.1-8m-ab"
        ? (await largeAbSystem()).system
        : await largeDiskSystem();
    const disk = source.slice();
    disk.set(system.subarray(0, 0x1a00));
    return disk;
  }
  await defaultResidents();
  if (![256256, 256512].includes(source.length)) {
    throw new Error(
      "System adaptation requires a supported legacy or 8 MiB disk geometry. Leave adaptation unchecked for exact recovery.",
    );
  }
  const length =
    Math.ceil(source.length / BACKING_SECTOR_BYTES) * BACKING_SECTOR_BYTES;
  const disk = new Uint8Array(length);
  disk.set(source);
  disk.set(ccp, CCP_SYSTEM_OFFSET);
  disk.set(bdos, BDOS_SYSTEM_OFFSET);
  disk.set(bios, BIOS_SYSTEM_OFFSET);
  return disk;
}

async function largeDiskSystem() {
  await defaultResidents();
  return fetchLargeDiskSystem({
    deployment,
    bootstrap: bootRom,
    ccp,
    bdos,
    baseUrl: document.baseURI,
  });
}

function largeAbSystem() {
  return fetchLargeAbDiskSystem({ deployment, baseUrl: document.baseURI });
}

async function selectedBootstrap(snapshot, choice) {
  if (choice === "current") return snapshot.bootstrap;
  if (snapshot.schema === "triptych-drive-set-v4")
    throw new Error(
      "Use drive configuration to change a two-MiB resident profile, or restore a complete historical archive.",
    );
  if (snapshot.drives.B && choice !== "triptych-cpu-v0.1-8m-ab")
    throw new Error(
      "Remove B explicitly before selecting a one-drive resident profile.",
    );
  if (choice === "triptych-cpu-v0.1-8m-ab") {
    const verified = await largeAbSystem();
    return { profile: verified.profile, bytes: verified.bootstrap };
  }
  if (!["legacy-e400", "triptych-cpu-v0.1-8m-a"].includes(choice))
    throw new Error("Select a known resident profile.");
  return { profile: choice, bytes: await defaultBootstrap() };
}

async function prepareMachine(snapshot) {
  if (snapshot.schema && snapshot.slots[0] === null)
    throw Object.assign(
      new Error("Restore the retained system disk to A before boot."),
      { code: "SYSTEM_DISK_RESTORE_REQUIRED" },
    );
  const candidate =
    store?.head?.kind === "ready"
      ? committed && sameDiskBoxView(snapshot, committed.snapshot)
        ? { manifest: store.head.manifest, slotWritable: store.slotWritable }
        : await store.prepareView(snapshot)
      : undefined;
  return prepareSavedMachineRuntime({
    snapshot,
    TriptychCpu,
    writable: !!writer?.owned,
    slotWritable: candidate?.slotWritable,
    deployment: candidate
      ? await runtimeDeployment(candidate.manifest)
      : deployment,
    guardSystemDisk: snapshot.schema === "triptych-drive-set-v4",
  });
}

function twoMibComLoadLimit(count) {
  return 65536 - 256 * Math.ceil(count / 2) - 6656 - 256;
}

function renderActiveConfiguration() {
  const summary = document.querySelector("#machine-summary");
  if (!activeMedia) {
    summary.textContent =
      "No active machine. Saved media remain available for recovery.";
    return;
  }
  const inserted = activeMedia.slots.flatMap((slot, index) =>
    slot ? [String.fromCharCode(65 + index)] : [],
  );
  const twoMib = /^triptych-cpu-v0\.1-2m-n/.test(activeMedia.profile);
  summary.textContent = `Active machine: ${activeMedia.configuredCount} configured slots; inserted media: ${inserted.join(", ")}. ${twoMib ? `COM load capacity: ${twoMibComLoadLimit(activeMedia.configuredCount)} bytes. ` : ""}Profile: ${activeMedia.profile}.`;
}

function resetConfigurationTarget() {
  // Synchronize at lifecycle boundaries, not in controls(): a control refresh
  // must not erase the user's unsubmitted target count.
  slotCount.value = /^triptych-cpu-v0\.1-2m-n/.test(activeMedia?.profile ?? "")
    ? String(activeMedia.configuredCount)
    : "4";
}

function activateMachine(prepared) {
  const previous = runtime;
  runtime = prepared;
  machine = prepared.cpu;
  activeMedia = prepared.media;
  resetConfigurationTarget();
  renderActiveConfiguration();
  lastFlushCounts = runtime.flushCounts();
  if (driveIndex() >= activeMedia.configuredCount) {
    selectedDrive = "A";
    driveSelect.value = "A";
  }
  terminal.clear();
  renderTerminal(terminalElement, terminal.snapshot());
  previous?.dispose();
}

function pauseMachine() {
  runGeneration += 1;
  machineRunning = false;
  setControlPending(false);
  mobileInput.value = "";
  mobileInput.blur();
  setKeyboardOpen(false);
  controls();
}

function resumeMachine() {
  machineRunning = true;
  // Workspace cancellation resumes synchronously before its caller clears the
  // old management token. Do not inspect staged Files state at this boundary.
  resetButton.disabled = filesDialog.open || !canRunMachine();
  setStatus(
    directSession
      ? directInstruction
      : `Running ${activeMedia.slots.map((slot, index) => `${String.fromCharCode(65 + index)}: ${slot?.name ?? "empty"}`).join(" · ")}${writer?.owned ? "" : " (read-only tab)"}; click or tap the terminal and type at A>.`,
    "running",
  );
  const generation = ++runGeneration;
  requestAnimationFrame(() => runMachine(generation));
}

terminalElement.addEventListener("keydown", (event) => {
  const bytes = keyEventToBytes(event);
  if (bytes === undefined) return;
  if (enqueueInput(bytes)) event.preventDefault();
});

terminalElement.addEventListener("paste", (event) => {
  if (machine === undefined) return;
  event.preventDefault();
  enqueueInput(textInputToBytes(event.clipboardData.getData("text")));
});

terminalElement.addEventListener("pointerup", (event) => {
  if (event.pointerType === "touch" || event.pointerType === "pen") {
    focusMobileInput();
  }
});

terminalElement.addEventListener("pointerdown", (event) => {
  // Suppress the compatibility mouse-down focus after a touch gesture. It can
  // otherwise move focus from the hidden keyboard input back to the terminal.
  if (event.pointerType === "touch" || event.pointerType === "pen")
    event.preventDefault();
});

showKeyboardButton.addEventListener("click", () => {
  if (document.body.classList.contains("terminal-keyboard-open")) {
    dismissMobileInput();
  } else {
    focusMobileInput();
  }
});

mobileInput.addEventListener("focus", () => setKeyboardOpen(true));
mobileInput.addEventListener("blur", () => setKeyboardOpen(false));

document
  .querySelector(".mobile-terminal-controls")
  .addEventListener("pointerdown", (event) => {
    event.preventDefault();
  });

controlKeyButton.addEventListener("click", () => {
  setControlPending(!controlPending);
  focusMobileInput();
});

for (const button of mobileKeyButtons) {
  button.addEventListener("click", () => {
    const bytes = keyEventToBytes({
      key: button.dataset.terminalKey,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    });
    if (bytes !== undefined) enqueueInput(bytes);
    setControlPending(false);
    focusMobileInput();
  });
}

mobileInput.addEventListener("beforeinput", (event) => {
  if (event.isComposing) return;
  const bytes = inputTypeToBytes(event.inputType);
  if (bytes === undefined) return;
  event.preventDefault();
  enqueueInput(bytes);
  setControlPending(false);
});

mobileInput.addEventListener("keydown", (event) => {
  if (event.isComposing || (!event.ctrlKey && event.key.length === 1)) return;
  const bytes = keyEventToBytes(event);
  if (bytes === undefined) return;
  if (enqueueInput(bytes)) event.preventDefault();
  setControlPending(false);
});

mobileInput.addEventListener("input", (event) => {
  if (event.isComposing) return;
  const text = mobileInput.value;
  mobileInput.value = "";
  if (text.length === 0) return;
  enqueueInput(textInputToBytes(text, { control: controlPending }));
  setControlPending(false);
});

window.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("resize", syncVisualViewport);
window.visualViewport?.addEventListener("scroll", syncVisualViewport);
syncVisualViewport();

resetButton.addEventListener("click", () => {
  if (!machineRunning || !canRunMachine() || filesDialog.open) return;
  machine.reset();
  if (machine.system_recovery_pending?.()) {
    showSystemRecovery();
    return;
  }
  terminal.clear();
  renderTerminal(terminalElement, terminal.snapshot());
  setStatus(
    directSession
      ? directInstruction
      : "Machine reset; disk contents and flushed writes were retained.",
    "running",
  );
  terminalElement.focus();
});

downloadButton.addEventListener("click", () => {
  const disk = imageAt(committed?.snapshot);
  if (disk) download(disk.bytes, disk.name);
});
downloadSetButton.addEventListener("click", async () => {
  try {
    if (committed?.snapshot.schema && committed.snapshot.slots[0] === null)
      throw new Error(
        "A is ejected. Download complete disk-box recovery (.tdbr); a bootable .tds archive requires A.",
      );
    if (committed)
      download(
        await encodeSavedMachine(committed.snapshot),
        "triptych-drives.tds",
      );
  } catch (error) {
    panelError(error);
  }
});
downloadCheckpointSetButton.addEventListener("click", async () => {
  try {
    download(
      await encodeSavedMachine(captureCheckpoint()),
      "checkpoint-triptych-drives.tds",
    );
  } catch (error) {
    panelError(error);
  }
});

function download(bytes, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
}

recoveryDownload.addEventListener("click", () => {
  if (machine && activeMedia.slots[driveIndex()])
    download(
      machine.export_drive_checkpoint(driveIndex()),
      `checkpoint-${activeMedia.slots[driveIndex()].name}`,
    );
});
retrySave.addEventListener("click", () => void saveCheckpoint());

function button(text, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.addEventListener("click", () =>
    Promise.resolve().then(action).catch(panelError),
  );
  return element;
}
function panelError(error) {
  filesStatus.textContent = message(error);
  controls();
}
function discardStaging() {
  stagedSet = undefined;
  importInput.value = "";
  diskInput.value = "";
  setInput.value = "";
}
function currentToken(token) {
  if (token !== managementToken || !token)
    throw new Error("This disk-management session has ended.");
  return workspace.inspect(token).snapshot;
}

function stagingRequest() {
  const token = managementToken;
  currentToken(token);
  const generation = ++stageGeneration;
  const drive = selectedDrive;
  return {
    token,
    drive,
    check() {
      currentToken(token);
      if (generation !== stageGeneration || drive !== selectedDrive)
        throw new Error("A newer staging action superseded this request.");
    },
  };
}

driveSelect.addEventListener("change", () => {
  driveIndex(driveSelect.value);
  selectedDrive = driveSelect.value;
  stageGeneration += 1;
  diagnosticAttempt += 1;
  void renderFiles().catch(panelError);
  controls();
});

for (const selector of ["#image-profile", "#adapt-image"]) {
  document.querySelector(selector).addEventListener("change", () => {
    stageGeneration += 1;
  });
}

async function readBackup(id) {
  return store.readBackup(id);
}

async function renderFiles() {
  const generation = ++panelGeneration;
  renderActiveConfiguration();
  displayedGeometry = undefined;
  fileList.replaceChildren();
  backupList.replaceChildren();
  toolsList.replaceChildren();
  const set = displayedSet();
  const snapshot = imageAt(set);
  if (snapshot) {
    document.querySelector("#disk-summary").textContent =
      `Drive ${selectedDrive}: ${snapshot.name} · committed revision ${workspace?.token?.revision ?? committed?.token?.revision ?? "legacy"}. Downloads include CP/M record padding.`;
    let disk;
    try {
      disk = new CpmDisk(snapshot.bytes);
      displayedGeometry = disk.geometry_id();
      const names = disk.file_names();
      for (const name of names) {
        const row = document.createElement("li");
        row.textContent = `${name} · ${disk.file_records(name) * 128} bytes${disk.file_read_only(name) ? " · read-only" : ""} `;
        const bytes = disk.read_file(name);
        row.append(button("Download", () => download(bytes, name)));
        fileList.append(row);
      }
      document.querySelector("#disk-summary").textContent +=
        ` Geometry: ${displayedGeometry === "ibm3740" ? "legacy IBM 3740" : displayedGeometry === "triptych-cpm-2m-v1" ? "2 MiB" : "8 MiB"}. Free: ${disk.free_bytes()} bytes, ${disk.free_directory_entries()} directory entries.`;
      if (catalog) {
        const identities = await identifyInstalledTools(
          catalog,
          (name) => (names.includes(name) ? disk.read_file(name) : undefined),
          { expectedDistribution: deployment.distribution },
        );
        if (generation !== panelGeneration) return;
        for (const item of identities) {
          const row = document.createElement("li");
          row.textContent = `${item.name}: ${item.status} `;
          row.append(
            button("Stage update", () =>
              stageTool(item.id, item.name, item.status),
            ),
          );
          toolsList.append(row);
        }
      } else
        toolsList.textContent =
          "Verified tool catalog unavailable. File downloads and disk recovery remain available.";
    } catch (error) {
      fileList.textContent = `Files unavailable: ${message(error)}. Download the complete disk for recovery.`;
    } finally {
      disk?.free();
    }
  } else
    document.querySelector("#disk-summary").textContent = set
      ? `Drive ${selectedDrive} is empty or outside this configuration. Configure slots before inserting media.`
      : "No committed working disk is available.";
  if (!store) return;
  try {
    const backups = (await store.listBackups()).sort(
      (a, b) =>
        (b.revision ?? -1) - (a.revision ?? -1) || a.id.localeCompare(b.id),
    );
    if (generation !== panelGeneration) return;
    for (const backup of backups) {
      const row = document.createElement("li");
      row.textContent = `${backup.id} · revision ${backup.revision ?? "unknown"} `;
      if (backup.kind === "recovery") {
        row.append(
          document.createTextNode(`Recovery required: ${backup.error}`),
        );
        backupList.append(row);
        continue;
      }
      row.append(
        button("Download backup", async () => {
          const drive = selectedDrive;
          const value = await readBackup(backup.id);
          if (!value) throw new Error("Backup is unavailable.");
          const disk = imageAt(value, drive);
          if (!disk)
            throw new Error(
              `Backup has no drive ${drive}; download the complete set instead.`,
            );
          download(disk.bytes, `backup-r${backup.revision}-${disk.name}`);
        }),
        button("Download set", async () => {
          const value = await readBackup(backup.id);
          if (!value) throw new Error("Backup is unavailable.");
          download(
            await encodeSavedMachine(value),
            `backup-r${backup.revision}-drives.tds`,
          );
        }),
      );
      const restore = button("Stage restore", async () => {
        const request = stagingRequest();
        const value = await readBackup(backup.id);
        request.check();
        if (!value) throw new Error("Backup is unavailable.");
        if (
          !confirm(
            "Stage this exact backup? Applying it will restart CP/M and back up the current disk.",
          )
        )
          return;
        stageSet(request.token, value);
        filesStatus.textContent = `Backup revision ${backup.revision} staged. Apply and restart to restore the complete drive set.`;
        controls();
      });
      restore.dataset.restore = "";
      row.append(restore);
      backupList.append(row);
    }
    if (!backups.length)
      backupList.textContent = "No manual-change backups yet.";
  } catch (error) {
    backupList.textContent = `Backups unavailable: ${message(error)}`;
  }
  controls();
}

filesButton.addEventListener("click", () => {
  setControlPending(false);
  mobileInput.value = "";
  mobileInput.blur();
  setKeyboardOpen(false);
  savedAcknowledgment.checked = false;
  discardAcknowledgment.checked = false;
  filesStatus.textContent = writer?.owned
    ? "Save and exit the guest editor before changing files. Listing shows committed data."
    : "Read-only session: close the other Triptych tab, then reload to change files.";
  filesDialog.showModal();
  controls();
  void renderFiles().catch(panelError);
});
savedAcknowledgment.addEventListener("change", controls);
discardAcknowledgment.addEventListener("change", controls);
async function enterManagement(recoverSaved = false) {
  const attempt = ++managementAttempt;
  try {
    const pending = recoverSaved
      ? workspace.beginRecovery({
          discardVolatile: discardAcknowledgment.checked,
        })
      : workspace.beginManagement({
          savedAndExited: savedAcknowledgment.checked,
        });
    controls();
    const token = await pending;
    if (attempt !== managementAttempt || !filesDialog.open) {
      workspace.cancel(token);
      controls();
      return;
    }
    managementToken = token;
    discardStaging();
    resetConfigurationTarget();
    filesStatus.textContent = recoverSaved
      ? "Recovery uses the saved disk only; guest RAM and unsaved writes are excluded. Stage a backup or disk image, then Apply to back up and restart."
      : "CPU paused. Import files or stage an update; Apply creates a backup and restarts CP/M.";
    await renderFiles();
  } catch (error) {
    panelError(error);
  }
  controls();
}
beginButton.addEventListener("click", () => void enterManagement());
recoveryButton.addEventListener("click", () => void enterManagement(true));
function cancelManagement() {
  if (managementToken) workspace.cancel(managementToken);
  managementToken = undefined;
  stageGeneration += 1;
  discardStaging();
  filesStatus.textContent = "Changes cancelled. The original CPU has resumed.";
  controls();
}
cancelButton.addEventListener("click", () => {
  try {
    cancelManagement();
    void renderFiles();
  } catch (error) {
    panelError(error);
  }
});
function closeFiles() {
  try {
    managementAttempt += 1;
    if (managementToken) cancelManagement();
    filesDialog.close();
    panelGeneration += 1;
    setControlPending(false);
    controls();
    terminalElement.focus({ preventScroll: true });
  } catch (error) {
    panelError(error);
  }
}
document.querySelector("#close-files").addEventListener("click", closeFiles);
filesDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeFiles();
});

async function stageImports(imports, token) {
  const baseline = currentToken(token);
  const candidate = stagedSet ?? baseline;
  if (
    store?.head?.kind === "ready" &&
    !diskBoxViewSlotWritable(
      store.configuration,
      committed?.snapshot,
      candidate,
      driveIndex(),
    )
  )
    throw new Error(
      "This disk is protected. Make a writable copy in Disk box first.",
    );
  const image = selectedImage(candidate);
  const disk = new CpmDisk(image.bytes);
  try {
    const existing = disk.file_names();
    const names = imports.map((value) => CpmDisk.canonical_name(value.name));
    if (new Set(names).size !== names.length)
      throw new Error("The batch contains duplicate CP/M filenames.");
    for (let index = 0; index < imports.length; index++) {
      const { bytes } = imports[index];
      const name = names[index];
      if (
        existing.includes(name) &&
        !confirm(
          `Replace ${name}? A full-disk backup is created when you apply.`,
        )
      )
        return;
      disk.add_import(name, bytes);
    }
    const value = copySavedMachine(candidate);
    replaceImage(value, selectedDrive, {
      ...image,
      bytes: disk.export_candidate(),
    });
    currentToken(token);
    stageSet(token, value);
    filesStatus.textContent = `Staged ${names.join(", ")}. Apply and restart to publish; nothing has changed on disk yet.`;
  } finally {
    disk.free();
    controls();
  }
}

importInput.addEventListener("change", async () => {
  const files = [...importInput.files];
  try {
    const request = stagingRequest();
    const imports = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      })),
    );
    request.check();
    await stageImports(imports, request.token);
  } catch (error) {
    panelError(error);
  } finally {
    importInput.value = "";
  }
});

diskInput.addEventListener("change", async () => {
  const [file] = diskInput.files;
  const adapt = document.querySelector("#adapt-image").checked;
  const profileChoice = document.querySelector("#image-profile").value;
  if (!file) return;
  try {
    const request = stagingRequest();
    const candidate = copySavedMachine(
      stagedSet ?? currentToken(request.token),
    );
    let bytes = new Uint8Array(await file.arrayBuffer());
    request.check();
    if (request.drive === "A") {
      candidate.bootstrap = await selectedBootstrap(candidate, profileChoice);
      request.check();
    }
    if (adapt) {
      if (request.drive !== "A")
        throw new Error(
          "System adaptation applies to drive A only; B is a data disk.",
        );
      if (
        !confirm(
          "Adapt this image by replacing its CCP, BDOS and BIOS with this Triptych release? Leave this unchecked for exact recovery.",
        )
      )
        return;
      bytes = await adaptedDisk(bytes, candidate.bootstrap.profile);
      request.check();
    }
    // Geometry and directory checks apply to Files, but exact whole-disk
    // recovery may legitimately contain an unsupported guest filesystem.
    replaceImage(candidate, request.drive, {
      ...(candidate.schema === "triptych-drive-set-v4"
        ? { instanceId: crypto.randomUUID() }
        : {}),
      name: file.name,
      bytes,
    });
    stageSet(request.token, candidate);
    filesStatus.textContent = `Staged exact disk ${file.name}${adapt ? " with explicit system adaptation" : ""}. Apply will back up and restart.`;
    controls();
  } catch (error) {
    panelError(error);
  } finally {
    diskInput.value = "";
  }
});

migrateButton.addEventListener("click", async () => {
  let disk;
  try {
    const request = stagingRequest();
    if (stagedSet)
      throw new Error(
        "Apply or cancel pending changes before upgrading the disk.",
      );
    if (request.drive !== "A")
      throw new Error("The one-drive upgrade applies to A only.");
    const baseline = currentToken(request.token);
    disk = new CpmDisk(baseline.drives.A.bytes);
    if (disk.geometry_id() !== "ibm3740")
      throw new Error("Only a legacy disk can be upgraded to 8 MiB.");
    if (
      !confirm(
        "Stage an 8 MiB upgrade of drive A? Files in all user areas are preserved; this release's CCP, BDOS and large-disk BIOS replace the system area. Apply and restart will preserve the complete previous disk as a backup.",
      )
    )
      return;
    migrationPending = true;
    controls();
    const system = await largeDiskSystem();
    request.check();
    if (stagedSet)
      throw new Error("Pending changes must be applied or cancelled first.");
    const value = copySavedMachine(baseline);
    value.drives.A.bytes = disk.migrate_to_eight_mib(system);
    value.bootstrap = {
      profile: "triptych-cpu-v0.1-8m-a",
      bytes: await defaultBootstrap(),
    };
    request.check();
    stageSet(request.token, value);
    filesStatus.textContent =
      "8 MiB upgrade staged. Apply and restart to publish with an exact backup of the previous disk. Nothing has changed on disk yet.";
  } catch (error) {
    panelError(error);
  } finally {
    disk?.free();
    migrationPending = false;
    controls();
  }
});

enableAbButton.addEventListener("click", async () => {
  let disk;
  try {
    const request = stagingRequest();
    if (stagedSet)
      throw new Error("Apply or cancel pending changes before enabling A/B.");
    const baseline = currentToken(request.token);
    if (baseline.bootstrap.profile === "triptych-cpu-v0.1-8m-ab")
      throw new Error("A/B is already enabled.");
    if (
      !confirm(
        "Enable eight MiB A/B? This explicitly replaces A's resident system. Legacy files are migrated; an existing eight MiB filesystem and reserved tail are preserved. Apply backs up the entire preceding drive set.",
      )
    )
      return;
    migrationPending = true;
    controls();
    const verified = await largeAbSystem();
    request.check();
    const value = copySavedMachine(baseline);
    disk = new CpmDisk(value.drives.A.bytes);
    if (disk.geometry_id() === "ibm3740")
      value.drives.A.bytes = disk.migrate_to_eight_mib(verified.system);
    else if (disk.geometry_id() === "triptych-cpm-8m-v1")
      value.drives.A.bytes.set(verified.system.subarray(0, 0x1a00));
    else throw new Error("Unsupported A filesystem for A/B transition.");
    value.bootstrap = { profile: verified.profile, bytes: verified.bootstrap };
    request.check();
    stageSet(request.token, value);
    filesStatus.textContent =
      "A/B enabled in the staged set. You can now stage blank B or attach an eight MiB B image, then Apply and restart.";
  } catch (error) {
    panelError(error);
  } finally {
    disk?.free();
    migrationPending = false;
    controls();
  }
});

blankBButton.addEventListener("click", () => {
  let disk;
  try {
    const token = managementToken;
    const value = copySavedMachine(stagedSet ?? currentToken(token));
    if (value.bootstrap.profile !== "triptych-cpu-v0.1-8m-ab" || value.drives.B)
      throw new Error("Blank B requires A/B and an absent B drive.");
    stageGeneration += 1;
    disk = CpmDisk.create_eight_mib();
    value.drives.B = { name: "triptych-b.img", bytes: disk.export_candidate() };
    stageSet(token, value);
    filesStatus.textContent =
      "Blank eight MiB B staged with no operating-system bytes. Apply backs up and restarts the complete set.";
    controls();
  } catch (error) {
    panelError(error);
  } finally {
    disk?.free();
  }
});

removeBButton.addEventListener("click", () => {
  try {
    const token = managementToken;
    const value = copySavedMachine(stagedSet ?? currentToken(token));
    if (!value.drives.B) throw new Error("B is not attached.");
    if (
      !confirm(
        "Stage removal of B? Apply preserves the complete preceding set as a backup. A's resident system stays unchanged.",
      )
    )
      return;
    stageGeneration += 1;
    value.drives.B = null;
    stageSet(token, value);
    filesStatus.textContent =
      "B removal staged. A's bytes and resident profile are unchanged.";
    controls();
  } catch (error) {
    panelError(error);
  }
});

setInput.addEventListener("change", async () => {
  const [file] = setInput.files;
  if (!file) return;
  try {
    const request = stagingRequest();
    const value = await decodeSavedMachineArchive(
      new Uint8Array(await file.arrayBuffer()),
    );
    request.check();
    if (
      !confirm(
        "Stage this complete saved set, including its exact bootstrap and all media slots? Apply backs up the current set and restarts.",
      )
    )
      return;
    stageSet(request.token, value);
    filesStatus.textContent =
      "Complete drive set staged for exact restoration. No system bytes were adapted.";
    controls();
  } catch (error) {
    panelError(error);
  } finally {
    setInput.value = "";
  }
});

configureButton.addEventListener("click", async () => {
  try {
    const request = stagingRequest();
    if (stagedSet)
      throw new Error(
        "Apply or cancel pending changes before configuring drives.",
      );
    const count = Number(slotCount.value);
    if (!Number.isInteger(count) || count < 1 || count > 16)
      throw new Error("Configure between 1 and 16 slots.");
    const baseline = currentToken(request.token);
    const removed = slots(baseline)
      .slice(count)
      .flatMap((slot, index) =>
        slot ? [String.fromCharCode(65 + count + index)] : [],
      );
    if (
      !confirm(
        `Configure ${count} two-MiB slots? The COM load limit becomes ${twoMibComLoadLimit(count)} bytes. This replaces A's resident system and migrates historical files if needed. ${removed.length ? `Removed media ${removed.join(", ")} remain in the complete preceding backup. ` : ""}Apply backs up the complete machine and cold reboots; tools are not upgraded.`,
      )
    )
      return;
    migrationPending = true;
    controls();
    const result = await prepareTwoMibConfiguration({
      snapshot: baseline,
      configuredCount: count,
      CpmDisk,
      deployment,
      baseUrl: document.baseURI,
    });
    request.check();
    if (stagedSet) throw new Error("A newer change has been staged.");
    stageSet(request.token, result.snapshot);
    filesStatus.textContent = `${count} two-MiB slots staged; COM load limit ${result.descriptor.layout.ccp - 256} bytes. Apply creates the complete preceding backup and restarts. Filesystem bytes of existing two-MiB media are unchanged.`;
  } catch (error) {
    panelError(error);
  } finally {
    migrationPending = false;
    controls();
  }
});
slotCount.addEventListener("change", () => {
  stageGeneration += 1;
});
blankDriveButton.addEventListener("click", () => {
  let disk;
  try {
    const token = managementToken;
    const value = copySavedMachine(stagedSet ?? currentToken(token));
    if (
      value.schema !== "triptych-drive-set-v4" ||
      imageAt(value) ||
      driveIndex() >= value.configuredCount
    )
      throw new Error(
        "A blank disk requires an empty configured two-MiB slot.",
      );
    stageGeneration += 1;
    disk = CpmDisk.create_two_mib();
    replaceImage(value, selectedDrive, {
      instanceId: crypto.randomUUID(),
      name: `triptych-${selectedDrive.toLowerCase()}.img`,
      bytes: disk.export_candidate(),
    });
    stageSet(token, value);
    filesStatus.textContent = `Blank ${selectedDrive} staged. Apply backs up and restarts the complete machine.`;
  } catch (error) {
    panelError(error);
  } finally {
    disk?.free();
    controls();
  }
});
ejectDriveButton.addEventListener("click", () => {
  try {
    const token = managementToken;
    const value = copySavedMachine(stagedSet ?? currentToken(token));
    if (
      value.schema !== "triptych-drive-set-v4" ||
      !imageAt(value) ||
      selectedDrive === "A"
    )
      throw new Error(
        "Ejection requires inserted media other than boot drive A.",
      );
    if (
      !confirm(
        `Eject ${selectedDrive}? The configured slot count and application RAM stay unchanged. Apply retains the complete preceding machine as a backup and reboots.`,
      )
    )
      return;
    stageGeneration += 1;
    replaceImage(value, selectedDrive, null);
    stageSet(token, value);
    filesStatus.textContent = `${selectedDrive} ejection staged; configured slots remain unchanged.`;
    controls();
  } catch (error) {
    panelError(error);
  }
});

async function stageTool(id, name, status) {
  const request = stagingRequest();
  if (
    status === "different-unknown" &&
    !confirm(
      `${name} differs from this release. It may be another valid version. Replace it with the verified release?`,
    )
  )
    return;
  const imports = await fetchToolUpdates(catalog, [id], {
    expectedDistribution: deployment.distribution,
    baseUrl: location.href,
  });
  request.check();
  await stageImports(imports, request.token);
}

function readJsonFile(disk, name) {
  const bytes = disk.read_file(name);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 26) end--;
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end)),
  );
}

function readProject(disk) {
  const manifestName = CpmDisk.canonical_name(
    document.querySelector("#project-file").value,
  );
  const project = readJsonFile(disk, manifestName);
  if (
    project.schema !== "triptych-nucleus-project-v1" ||
    !Array.isArray(project.sources) ||
    !project.sources.length ||
    project.sources.length > 16
  )
    throw new Error("Project requires an ordered list of 1–16 source files.");
  const names = [...project.sources, project.output, project.sourceMap];
  if (
    names.some((name) => CpmDisk.canonical_name(name) !== name) ||
    new Set([...names, manifestName]).size !== names.length + 1
  )
    throw new Error(
      "Project names must be distinct, uppercase CP/M filenames.",
    );
  if (!project.output.endsWith(".NU"))
    throw new Error("The generated Nucleus input must have a .NU extension.");
  const stem = project.output.slice(0, -3);
  const compilerNames = ["COM", "$$$", "BAK"].map(
    (extension) => `${stem}.${extension}`,
  );
  if ([...names, manifestName].some((name) => compilerNames.includes(name)))
    throw new Error(
      "A project file collides with a compiler output or scratch file.",
    );
  return {
    outputName: project.output,
    mapName: project.sourceMap,
    sources: project.sources.map((name) => ({
      name,
      bytes: disk.read_file(name),
    })),
  };
}

prepareBuildButton.addEventListener("click", async () => {
  let disk;
  try {
    const request = stagingRequest();
    const baseline = currentToken(request.token);
    disk = new CpmDisk(selectedImage(stagedSet ?? baseline).bytes);
    const project = readProject(disk);
    const bundle = await prepareSourceBundle(project, {
      canonicalName: CpmDisk.canonical_name,
    });
    request.check();
    await stageImports(
      [
        { name: bundle.name, bytes: bundle.bytes },
        {
          name: project.mapName,
          bytes: new TextEncoder().encode(JSON.stringify(bundle.map)),
        },
      ],
      request.token,
    );
  } catch (error) {
    panelError(error);
  } finally {
    disk?.free();
  }
});

function projectSnapshot() {
  return managementToken
    ? imageAt(stagedSet ?? currentToken(managementToken))?.bytes
    : machine
      ? !activeMedia.slots[driveIndex()]
        ? undefined
        : machine.export_drive_checkpoint(driveIndex())
      : imageAt(committed?.snapshot)?.bytes;
}

document
  .querySelector("#locate-diagnostic")
  .addEventListener("click", async () => {
    let disk;
    const attempt = ++diagnosticAttempt;
    const panel = panelGeneration;
    const stage = stageGeneration;
    const token = managementToken;
    const drive = selectedDrive;
    const projectName = document.querySelector("#project-file").value;
    const diagnostic = document.querySelector("#nucleus-diagnostic").value;
    let snapshot;
    const current = () => {
      if (
        !filesDialog.open ||
        attempt !== diagnosticAttempt ||
        panel !== panelGeneration ||
        stage !== stageGeneration ||
        token !== managementToken ||
        drive !== selectedDrive ||
        projectName !== document.querySelector("#project-file").value ||
        diagnostic !== document.querySelector("#nucleus-diagnostic").value
      )
        return false;
      const now = projectSnapshot();
      return (
        snapshot?.length === now?.length &&
        snapshot?.every((byte, index) => byte === now[index])
      );
    };
    try {
      const raw = diagnostic.trim();
      const match =
        /^Nucleus error [0-9A-F]{2} P=01 O=([0-9A-F]{4}) L=[0-9A-F]{4} C=[0-9A-F]{4}$/i.exec(
          raw,
        );
      if (!match)
        throw new Error(
          "Paste the complete single-input Nucleus diagnostic, including P=01 and O=....",
        );
      // Mapping describes disk sources, never unsaved editor RAM. Revalidate
      // against the latest complete guest checkpoint when the CPU is running.
      snapshot = projectSnapshot()?.slice();
      if (!snapshot)
        throw new Error("No disk is available for source mapping.");
      disk = new CpmDisk(snapshot);
      const project = readProject(disk);
      const map = readJsonFile(disk, project.mapName);
      const result = await mapSourceBundleOffset(
        {
          sources: project.sources,
          bundle: {
            name: project.outputName,
            bytes: disk.read_file(project.outputName),
          },
          map,
          offset: Number.parseInt(match[1], 16),
        },
        { canonicalName: CpmDisk.canonical_name },
      );
      if (current())
        filesStatus.textContent = `${raw} → ${result.name}, line ${result.line}, column ${result.column} (saved source${result.synthetic ? ", inserted boundary newline" : ""}).`;
    } catch (error) {
      if (!snapshot || current()) panelError(error);
    } finally {
      disk?.free();
    }
  });

starterButton.addEventListener("click", async () => {
  try {
    const request = stagingRequest();
    const imports = await Promise.all(
      ["IO.NU", "MAIN.NU", "BUILD.JSN"].map(async (name) => {
        const path = `adventure-${name}`;
        const asset = deployment.assets.find((item) => item.path === path);
        if (!asset)
          throw new Error("Adventure asset missing from deployment manifest.");
        const response = await fetch(path, {
          cache: "no-store",
          redirect: "error",
        });
        if (!response.ok) throw new Error(`Could not load ${path}.`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        const digest = [
          ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
        ]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        if (bytes.length !== asset.bytes || digest !== asset.sha256)
          throw new Error(`Adventure asset verification failed: ${name}.`);
        return { name, bytes };
      }),
    );
    request.check();
    await stageImports(imports, request.token);
  } catch (error) {
    panelError(error);
  }
});

commitButton.addEventListener("click", async () => {
  const token = managementToken;
  try {
    const pending = workspace.commit(token);
    controls();
    await pending;
    managementToken = undefined;
    discardStaging();
    filesStatus.textContent =
      "Disk committed with a recovery backup. CP/M restarted.";
    setSaveStatus("Saved in this browser", "saved");
  } catch (error) {
    panelError(error);
  } finally {
    try {
      await refreshCommitted();
      await renderFiles();
    } catch (error) {
      panelError(error);
    }
    controls();
  }
});

async function refreshCommitted() {
  const generation = ++committedGeneration;
  const state = await store.load();
  // Loading verifies a captured head asynchronously. A newer refresh or an
  // acknowledged save may already have replaced this cached download source.
  if (generation === committedGeneration)
    committed = state.kind === "ready" ? state : undefined;
  return state;
}

async function rawRecovery() {
  if (!store) return;
  const v2 = await store
    .readRawRecovery("disk-revisions", "head")
    .catch(() => undefined);
  const v1 = await store
    .readRawRecovery("working-disks", "drive-a")
    .catch(() => undefined);
  const legacy = v2?.bytes ? v2 : v1;
  if (legacy?.bytes) {
    document.querySelector("#legacy-recovery").hidden = false;
    document.querySelector("#legacy-recovery").onclick = () =>
      download(legacy.bytes, "legacy-recovery.img");
  }
  const target = document.querySelector("#raw-recovery");
  target.replaceChildren();
  const boxHead = await store
    .readRawRecovery("disk-box-state-v1", "head")
    .catch(() => undefined);
  if (boxHead) {
    target.append(
      button("Download raw disk-box manifest", () =>
        download(
          new TextEncoder().encode(JSON.stringify(boxHead)),
          "disk-box-head.json",
        ),
      ),
    );
    if (Array.isArray(boxHead.manifest?.personalDisks)) {
      for (const disk of boxHead.manifest.personalDisks) {
        if (
          typeof disk?.id !== "string" ||
          typeof disk?.content?.sha256 !== "string"
        )
          continue;
        const raw = await store
          .readRawRecovery("disk-box-blobs-v1", disk.content.sha256)
          .catch(() => undefined);
        if (!raw?.bytes) continue;
        const entry = button(
          `Download raw ${typeof disk.name === "string" ? disk.name : disk.id}`,
          () => download(raw.bytes, `recovery-${disk.id}.img`),
        );
        entry.dataset.recoveryDiskId = disk.id;
        target.append(entry);
      }
    }
  }
  for (const [stateStore, blobStore, version] of [
    ["drive-set-state-v4", "drive-set-blobs-v4", "v4"],
    ["drive-set-state", "drive-set-blobs", "v3"],
  ]) {
    const head = await store
      .readRawRecovery(stateStore, "head")
      .catch(() => undefined);
    if (!head) continue;
    target.append(
      button(`Download raw ${version} saved manifest`, () =>
        download(
          new TextEncoder().encode(JSON.stringify(head)),
          `${version}-drive-set-head.json`,
        ),
      ),
    );
    const refs = [
      ["bootstrap", head.manifest?.bootstrap?.image],
      ...(Array.isArray(head.manifest?.slots)
        ? head.manifest.slots
            .slice(0, 16)
            .map((slot, index) => [
              String.fromCharCode(65 + index),
              slot?.image,
            ])
        : [
            ["A", head.manifest?.drives?.A?.image],
            ["B", head.manifest?.drives?.B?.image],
          ]),
    ];
    for (const [name, reference] of refs) {
      if (typeof reference?.sha256 !== "string") continue;
      const raw = await store
        .readRawRecovery(blobStore, reference.sha256)
        .catch(() => undefined);
      if (raw?.bytes)
        target.append(
          button(`Download raw ${version} ${name}`, () =>
            download(raw.bytes, `recovery-${version}-${name}.bin`),
          ),
        );
    }
  }
}

function connectWorkspace() {
  const coordinatedStore = {
    load: () => store.load(),
    commitChange: (...args) => store.commitChange(...args),
    async saveCheckpoint(token, value) {
      const snapshot = copyDiskBoxView(value);
      const publication = await store.saveCheckpoint(token, snapshot);
      committedGeneration += 1;
      committed = {
        kind: "ready",
        token: publication.token,
        snapshot,
        receipt: publication.receipt,
      };
      return publication;
    },
  };
  workspace = createDiskBoxArchiveWorkspace({
    store: coordinatedStore,
    writer,
    token: committed.token,
    runtime: {
      pause: pauseMachine,
      resume: resumeMachine,
      ready: () => machine.disk_management_ready(),
      checkpoint: captureCheckpoint,
      prepare: prepareMachine,
      activate: activateMachine,
      discard: (prepared) => prepared.dispose(),
    },
  });
}

let libraryBusy = false;
let librarySession;
const libraryStatus = document.querySelector("#library-status");
const librarySlot = document.querySelector("#library-slot");
const libraryReady = document.querySelector("#library-ready");
const restoreSystemButton = document.querySelector("#restore-system-disk");
let startupSystemRecovery = false;
function showSystemRecovery() {
  startupSystemRecovery = !machine;
  pauseMachine();
  showLibraryView();
  restoreSystemButton.hidden = false;
  libraryStatus.textContent =
    "The guest needs its retained system disk in A. Confirm closed/flushed files, then Restore system disk. Dirty transfers or pending input remain paused for explicit recovery; no media are replaced automatically.";
  setStatus(
    machine
      ? "System disk required before boot can continue. Guest CPU and RAM are paused."
      : "Restore the retained system disk before cold boot. Saved media have not been changed.",
    "recovery",
  );
}
const libraryHash = async (bytes) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
function libraryError(error) {
  libraryStatus.textContent = message(error);
  libraryStatus.scrollIntoView({ block: "start", behavior: "smooth" });
  libraryStatus.focus({ preventScroll: true });
  controls();
}
function currentLibrarySlot() {
  return Number(librarySlot.value);
}
function updateLiveView(snapshot) {
  const previous = runtime,
    cpu = machine,
    boot = {
      profile: snapshot.bootstrap.profile,
      bytes: new Uint8Array(snapshot.bootstrap.bytes),
    };
  const version = snapshot.schema,
    metadata = slots(snapshot).map((slot) =>
      slot
        ? {
            name: slot.name,
            ...(version ? { instanceId: slot.instanceId } : {}),
          }
        : null,
    );
  const count = version
    ? snapshot.configuredCount
    : activeMedia.configuredCount;
  runtime = {
    cpu,
    systemGuardEnabled: previous.systemGuardEnabled,
    media: {
      profile: boot.profile,
      configuredCount: count,
      slots: metadata.slice(0, count),
    },
    captureCheckpoint() {
      const images = metadata.map((slot, index) =>
        slot ? { ...slot, bytes: cpu.export_drive_checkpoint(index) } : null,
      );
      const bootstrap = {
        profile: boot.profile,
        bytes: new Uint8Array(boot.bytes),
      };
      return version
        ? { schema: version, configuredCount: count, bootstrap, slots: images }
        : { bootstrap, drives: { A: images[0], B: images[1] ?? null } };
    },
    flushCounts: () =>
      metadata
        .slice(0, count)
        .map((slot, index) => (slot ? cpu.drive_flush_count(index) : 0)),
    dispose: () => previous.dispose(),
  };
  activeMedia = runtime.media;
  lastFlushCounts = runtime.flushCounts();
  renderActiveConfiguration();
}
async function libraryBarrier({ requireGuestReady = true } = {}) {
  if (libraryBusy || managementToken || !workspace?.canRun || !writer?.owned)
    throw new Error(
      "Finish the current operation before changing the disk box.",
    );
  if (requireGuestReady && !libraryReady.checked)
    throw new Error(
      "Confirm that the guest has closed files and flushed first.",
    );
  libraryBusy = true;
  try {
    const token = await workspace.beginManagement({ savedAndExited: true });
    await refreshCommitted();
    return token;
  } catch (error) {
    libraryBusy = false;
    throw error;
  }
}
async function libraryCommit(candidate, barrier, restart = false) {
  let prepared;
  try {
    const snapshot = await store.snapshotFor(
      candidate.manifest,
      candidate.newBlobs,
    );
    if (restart) {
      const config = candidate.manifest.configurations.find(
        (item) => item.id === candidate.manifest.selectedConfigurationId,
      );
      prepared = await prepareSavedMachineRuntime({
        snapshot,
        TriptychCpu,
        writable: !!writer.owned,
        slotWritable: config.slots.map(
          (slot) => slot?.kind === "personal" && slot.writable,
        ),
        deployment: await runtimeDeployment(candidate.manifest),
        guardSystemDisk: snapshot.schema === "triptych-drive-set-v4",
      });
    }
    const publication = await store.authority.commitChange(
      store.head.token,
      crypto.randomUUID(),
      candidate.manifest,
      candidate.newBlobs,
    );
    if (publication.status !== "committed")
      throw new Error(
        "Disk-box change was superseded; reload the durable state.",
      );
    await workspace.close();
    const loaded = await refreshCommitted();
    requireExactPublication(publication, loaded, snapshot);
    if (prepared) {
      activateMachine(prepared);
      prepared = undefined;
    } else updateLiveView(committed.snapshot);
    connectWorkspace();
    resumeMachine();
    libraryBusy = false;
    libraryReady.checked = false;
    await renderLibrary();
    if (restart) showComputerView();
  } catch (error) {
    prepared?.dispose();
    libraryStatus.textContent =
      "Disk box is paused for recovery; reload to inspect durable state. " +
      message(error);
    throw error;
  }
}
async function insertLibraryBinding(
  binding,
  incomingBytes,
  { restoreSystem = false, slot = currentLibrarySlot() } = {},
) {
  if (slot === 0 && !runtime?.systemGuardEnabled)
    throw new Error(
      "This historical runtime has no admitted system-disk guard. A changes require explicit archive restart.",
    );
  const barrier = await libraryBarrier();
  let committedLive = false;
  try {
    librarySession = await prepareDiskBoxMediaChange({
      manifest: store.head.manifest,
      token: store.head.token,
      configurationId: store.configuration.id,
      slot,
      binding,
      incomingBytes,
      cpu: machine,
      store: store.authority,
      lease: { isOwner: () => !!writer.owned },
      pause: pauseMachine,
      resume: () => {
        if (committedLive) resumeMachine();
        else {
          workspace.cancel(barrier);
          libraryBusy = false;
        }
      },
      onCommitted: async (published) => {
        await workspace.close();
        const loaded = await refreshCommitted();
        if (
          loaded.kind !== "ready" ||
          loaded.token.digest !== published.token.digest ||
          loaded.token.revision !== published.token.revision
        )
          throw new Error(
            "Disk box authority changed during media restoration; reload for recovery.",
          );
        updateLiveView(committed.snapshot);
        if (
          restoreSystem &&
          machine.system_recovery_pending() &&
          !machine.complete_system_disk_restore()
        )
          throw new Error(
            "System restoration is durable, but the guarded CPU remains paused. Dirty storage or pending input requires explicit recovery.",
          );
        connectWorkspace();
        committedLive = true;
        libraryBusy = false;
        libraryReady.checked = false;
        restoreSystemButton.hidden = false;
      },
    });
    await librarySession.commit();
    librarySession = undefined;
    await renderLibrary();
  } catch (error) {
    document.querySelector("#library-retry").hidden =
      librarySession?.status !== "uncertain";
    throw error;
  }
}
async function addPersonal(bytes, name) {
  const image = new CpmDisk(bytes);
  let geometry;
  try {
    geometry = image.geometry_id();
  } finally {
    image.free();
  }
  const barrier = await libraryBarrier({ requireGuestReady: false });
  const manifest = structuredClone(store.head.manifest),
    sha256 = await libraryHash(bytes);
  manifest.personalDisks.push({
    id: crypto.randomUUID(),
    name,
    geometry,
    content: { sha256, byteLength: bytes.length },
  });
  await libraryCommit(
    { manifest, newBlobs: new Map([[sha256, bytes]]) },
    barrier,
  );
}
let libraryRenderGeneration = 0;
async function renderLibrary() {
  const generation = ++libraryRenderGeneration;
  const personal = document.querySelector("#personal-disk-list"),
    published = document.querySelector("#published-disk-list");
  personal.replaceChildren();
  published.replaceChildren();
  if (store?.head?.kind !== "ready") return;
  const config = store.configuration,
    selected = Number(librarySlot.value || 1);
  const mountedDrives = document.querySelector("#mounted-drive-list");
  mountedDrives.replaceChildren();
  for (let index = 0; index < config.configuredCount; index++) {
    const binding = config.slots[index];
    const row = document.createElement("li");
    const title = document.createElement("span");
    title.className = "disk-title";
    const diskName =
      binding?.kind === "published"
        ? binding.image.name
        : binding?.kind === "personal"
          ? store.head.manifest.personalDisks.find(
              (disk) => disk.id === binding.diskId,
            )?.name
          : undefined;
    title.textContent = `${String.fromCharCode(65 + index)}: ${diskName ?? "Empty"}`;
    const state = document.createElement("span");
    state.className = "disk-state";
    state.textContent = binding
      ? binding.kind === "published"
        ? "Read-only"
        : "Writable"
      : "No disk";
    row.append(title, state);
    mountedDrives.append(row);
  }
  const configurations = document.querySelector("#saved-configuration");
  configurations.replaceChildren();
  for (const saved of store.head.manifest.configurations) {
    const option = document.createElement("option");
    option.value = saved.id;
    option.textContent = saved.name;
    configurations.append(option);
  }
  configurations.value = config.id;
  document.querySelector("#local-configuration-bookmark").href =
    localConfigurationBookmark(config.id);
  restoreSystemButton.hidden =
    !startupSystemRecovery && !machine?.system_recovery_pending?.();
  librarySlot.replaceChildren();
  for (let i = 0; i < config.configuredCount; i++) {
    const option = document.createElement("option");
    option.value = i;
    option.textContent = String.fromCharCode(65 + i);
    librarySlot.append(option);
  }
  librarySlot.value = String(Math.min(selected, config.configuredCount - 1));
  for (const disk of store.head.manifest.personalDisks) {
    const row = document.createElement("li");
    row.dataset.diskId = disk.id;
    const mounted = config.slots.flatMap((slot, index) =>
      slot?.kind === "personal" && slot.diskId === disk.id
        ? [String.fromCharCode(65 + index)]
        : [],
    );
    const title = document.createElement("span");
    title.className = "disk-title";
    title.textContent = disk.name;
    const state = document.createElement("span");
    state.className = "disk-state";
    state.textContent = mounted.length
      ? `Writable · in ${mounted.join(", ")}`
      : "Writable · not inserted";
    row.append(title, state);
    const insertButton = button("Insert", async () => {
      try {
        await insertLibraryBinding(
          { kind: "personal", diskId: disk.id, writable: true },
          await store.authority.readPersonalDisk(disk.id),
        );
      } catch (error) {
        libraryError(error);
      }
    });
    insertButton.dataset.libraryInsert = "";
    insertButton.dataset.diskName = disk.name;
    row.append(insertButton);
    row.append(
      button("Download", async () =>
        download(
          await store.authority.readPersonalDisk(disk.id),
          disk.name + ".img",
        ),
      ),
    );
    row.append(
      button("Rename", async () => {
        try {
          const name = prompt("Personal disk name", disk.name);
          if (name === null) return;
          const barrier = await libraryBarrier({ requireGuestReady: false }),
            manifest = structuredClone(store.head.manifest);
          manifest.personalDisks.find((item) => item.id === disk.id).name =
            name;
          await libraryCommit({ manifest, newBlobs: new Map() }, barrier);
        } catch (error) {
          libraryError(error);
        }
      }),
    );
    personal.append(row);
  }
  const recipe = await libraryRecipe("starter");
  if (generation !== libraryRenderGeneration) return;
  document.querySelector("#share-starter").href =
    "?recipe=starter&revision=" +
    encodeURIComponent(recipe.descriptor.revision);
  const protectedRecipe = await libraryRecipe("library");
  if (generation !== libraryRenderGeneration) return;
  document.querySelector("#share-library").href =
    "?recipe=library&revision=" +
    encodeURIComponent(protectedRecipe.descriptor.revision);
  const retained = await registry();
  if (generation !== libraryRenderGeneration) return;
  const cave = retained.metadata.defaults.find(
    (reference) => reference.id === "colossal-cave-350",
  );
  document.querySelector("#colossal-cave-guide").hidden = !cave;
  if (cave)
    document.querySelector("#share-colossal-cave").href =
      "?recipe=" +
      encodeURIComponent(cave.id) +
      "&revision=" +
      encodeURIComponent(cave.revision);
  const catalogue = {
    schema: "triptych-disk-catalogue-v1",
    images: retained.metadata.images,
  };
  const currentImages = new Map();
  for (const image of catalogue.images) currentImages.set(image.id, image);
  for (const entry of currentImages.values()) {
    const slot = {
      kind: "published",
      image: publishedImageReference(
        catalogue,
        entry.id,
        entry.revision,
        retained.url,
      ),
    };
    const row = document.createElement("li");
    row.dataset.publishedImageId = entry.id;
    row.dataset.publishedImageRevision = entry.revision;
    const title = document.createElement("span");
    title.className = "disk-title";
    title.textContent = slot.image.name;
    const state = document.createElement("span");
    state.className = "disk-state";
    state.textContent = `Read-only · ${Math.round(entry.byteLength / 1048576)} MB`;
    row.append(title, state);
    const insertButton = button("Insert", async () => {
      try {
        const { fetchPublishedImage } = await import("./disk-catalogue.js");
        await insertLibraryBinding(slot, await fetchPublishedImage(slot.image));
      } catch (error) {
        libraryError(error);
      }
    });
    insertButton.dataset.libraryInsert = "";
    insertButton.dataset.diskName = slot.image.name;
    row.append(insertButton);
    published.append(row);
  }
  updateLibraryDriveActions();
  libraryStatus.textContent = "";
}

function updateLibraryDriveActions() {
  const drive = String.fromCharCode(65 + currentLibrarySlot());
  document.querySelector("#library-eject").textContent = `Eject ${drive}`;
  for (const button of document.querySelectorAll("[data-library-insert]")) {
    button.textContent = `Insert into ${drive}`;
    button.setAttribute(
      "aria-label",
      `Insert ${button.dataset.diskName} into drive ${drive}`,
    );
  }
}

librarySlot.addEventListener("change", updateLibraryDriveActions);
document.querySelector("#library-blank").addEventListener("click", async () => {
  let disk;
  try {
    disk = CpmDisk.create_two_mib();
    await addPersonal(
      disk.export_source(),
      document.querySelector("#library-name").value,
    );
  } catch (error) {
    libraryError(error);
  } finally {
    disk?.free();
  }
});
document
  .querySelector("#library-import")
  .addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 8388608) throw new Error("Image is too large.");
      await addPersonal(
        new Uint8Array(await file.arrayBuffer()),
        document.querySelector("#library-name").value,
      );
    } catch (error) {
      libraryError(error);
    } finally {
      event.target.value = "";
    }
  });
document.querySelector("#library-copy").addEventListener("click", async () => {
  try {
    const image = slots(committed?.snapshot)[currentLibrarySlot()];
    if (!image) throw new Error("Selected drive is empty.");
    await addPersonal(
      new Uint8Array(image.bytes),
      document.querySelector("#library-name").value,
    );
  } catch (error) {
    libraryError(error);
  }
});
document
  .querySelector("#library-eject")
  .addEventListener("click", () =>
    insertLibraryBinding(null).catch(libraryError),
  );
document.querySelector("#library-retry").addEventListener("click", async () => {
  try {
    await librarySession.commit();
    librarySession = undefined;
    document.querySelector("#library-retry").hidden = true;
    await renderLibrary();
  } catch (error) {
    libraryError(error);
  }
});
document
  .querySelector("#saved-configuration")
  .addEventListener("change", (event) => {
    document.querySelector("#local-configuration-bookmark").href =
      localConfigurationBookmark(event.target.value);
  });
document
  .querySelector("#activate-configuration")
  .addEventListener("click", async () => {
    try {
      const id = document.querySelector("#saved-configuration").value;
      if (!store?.head?.manifest.configurations.some((item) => item.id === id))
        throw new Error(
          "Device-local configuration not found. Saved data has not changed.",
        );
      if (id === store.head.manifest.selectedConfigurationId) return;
      if (
        !confirm(
          "Activate this saved configuration and restart CP/M? Every other configuration and personal disk will be retained.",
        )
      )
        return;
      const barrier = await libraryBarrier();
      const manifest = structuredClone(store.head.manifest);
      manifest.selectedConfigurationId = id;
      await libraryCommit({ manifest, newBlobs: new Map() }, barrier, true);
    } catch (error) {
      libraryError(error);
    }
  });
for (const [id, freshInstance, libraryOnly, useRequested] of [
  ["launch-starter", false, false],
  ["launch-fresh", true, false],
  ["launch-library", false, true],
  ["launch-requested", false, false, true],
])
  document.querySelector("#" + id).addEventListener("click", async () => {
    try {
      const recipe = useRequested
        ? requestedRecipe
        : await libraryRecipe(libraryOnly ? "library" : "starter");
      if (!recipe)
        throw new Error("No verified requested recipe is available.");
      const arrangement = recipe.descriptor.slots
        .map(
          (slot, index) =>
            `${String.fromCharCode(65 + index)}: ${
              slot === null
                ? "empty"
                : slot.kind === "published"
                  ? "protected published disk"
                  : "personal writable disk"
            }`,
        )
        .join(", ");
      if (
        !confirm(
          (useRequested
            ? `Activate requested setup “${recipe.descriptor.name}”? Reuse its existing local instance unchanged if present; otherwise create a new configuration with ${arrangement}. `
            : libraryOnly
              ? "Activate protected A/C with empty B/D? "
              : "Activate protected A/C and personal B/D? ") +
            "The current configuration and every personal disk will be retained. CP/M will restart.",
        )
      )
        return;
      const barrier = await libraryBarrier();
      let candidate;
      try {
        candidate = await prepareDiskBoxRecipeLaunch(
          store.head.manifest,
          recipe,
          { freshInstance },
        );
      } catch (error) {
        // No publication has been attempted. Release only this preparation's
        // session; once libraryCommit begins, its fail-stopped policy applies.
        workspace.cancel(barrier);
        libraryBusy = false;
        throw error;
      }
      await libraryCommit(candidate, barrier, true);
    } catch (error) {
      libraryError(error);
    }
  });
document
  .querySelector("#library-backup")
  .addEventListener("click", async () => {
    try {
      const stores = await store.readRawSnapshot();
      download(
        await encodeDiskBoxRecovery(stores),
        "triptych-disk-box-recovery.tdbr",
      );
    } catch (error) {
      libraryError(error);
    }
  });

function eraseDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      libraryStatus.textContent =
        "Waiting for another Triptych tab to close before erasing…";
    };
  });
}

function startFreshPending() {
  try {
    return localStorage.getItem(startFreshMarker) === "yes";
  } catch {
    return false;
  }
}

async function resumeInterruptedStartFresh() {
  if (!startFreshPending()) return;
  setStatus("Finishing an interrupted browser reset…");
  const leases = await Promise.all([
    acquireDiskWriter({ name: "triptych-cpu:disk-writer" }),
    acquireDiskWriter({ name: "triptych-supplied:disk-writer" }),
  ]);
  try {
    if (leases.some((lease) => !lease.owned))
      throw new Error(
        "Close every other Triptych tab, then reload to finish the browser reset.",
      );
    await Promise.all([
      eraseDatabase("triptych-cpu"),
      eraseDatabase("triptych-supplied"),
    ]);
    localStorage.removeItem(startFreshMarker);
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }
}

async function refreshPublishedApplication() {
  const base = new URL("./", location.href);
  const page = new URL("index.html", base);
  page.searchParams.set("fresh", Date.now());
  const urls = new Set([
    page.href,
    new URL("app.js", base).href,
    new URL("style.css", base).href,
    new URL("triptych_host_wasm.js", base).href,
    new URL("triptych_host_wasm_bg.wasm", base).href,
    new URL("deployment-manifest.json", base).href,
    new URL("disk-library-registry.json", base).href,
    new URL("tool-catalog.json", base).href,
    new URL("bootstrap.bin", base).href,
  ]);
  for (const entry of performance.getEntriesByType("resource")) {
    const url = new URL(entry.name);
    if (
      url.origin === location.origin &&
      url.pathname.startsWith(base.pathname) &&
      /\.(?:css|html|js|json|wasm)$/.test(url.pathname)
    )
      urls.add(url.href);
  }
  const responses = await Promise.all(
    [...urls].map((url) => fetch(url, { cache: "reload", redirect: "error" })),
  );
  const failed = responses.find((response) => !response.ok);
  if (failed)
    throw new Error(
      `The latest Triptych software could not be loaded (${failed.status}). Saved data was not erased.`,
    );
}

document
  .querySelector("#erase-triptych-data")
  .addEventListener("click", async () => {
    if (
      !confirm(
        "Erase every Triptych machine and data disk saved in this browser? Download a backup first if you may need them. This cannot be undone.",
      )
    )
      return;
    let otherWriter;
    let tornDown = false;
    try {
      if (!writer?.owned || libraryBusy || workspace?.state !== "running")
        throw new Error(
          "Start fresh in the tab that owns this machine, with no disk operation in progress.",
        );
      const otherStorageName =
        storageName === "triptych-cpu" ? "triptych-supplied" : "triptych-cpu";
      otherWriter = await acquireDiskWriter({
        name: `${otherStorageName}:disk-writer`,
      });
      if (!otherWriter.owned)
        throw new Error(
          "Close every other Triptych tab, then try Start fresh again. Saved data was not erased.",
        );
      libraryStatus.textContent = "Loading the latest Triptych software…";
      await refreshPublishedApplication();
      localStorage.setItem(startFreshMarker, "yes");
      libraryStatus.textContent = "Removing saved Triptych data…";
      pauseMachine();
      await workspace?.close();
      runtime?.dispose();
      runtime = undefined;
      machine = undefined;
      store?.close();
      store = undefined;
      tornDown = true;
      await Promise.all([
        eraseDatabase("triptych-cpu"),
        eraseDatabase("triptych-supplied"),
      ]);
      localStorage.removeItem(startFreshMarker);
      await writer.release();
      writer = undefined;
      await otherWriter.release();
      otherWriter = undefined;
      location.replace(`${location.pathname}?fresh=${Date.now()}`);
    } catch (error) {
      await otherWriter?.release();
      if (!tornDown) libraryError(error);
      else {
        alert(`${message(error)} Reloading Triptych.`);
        location.reload();
      }
    }
  });

restoreSystemButton.addEventListener("click", async () => {
  let checked;
  try {
    if (!writer?.owned || store?.head?.kind !== "ready" || libraryBusy)
      throw new Error(
        "System restoration requires the owning tab and no pending disk-box operation.",
      );
    if (
      !confirm(
        "Restore this configuration's retained system disk to A? The displaced personal disk stays in your disk box. This does not install a newer system.",
      )
    )
      return;
    const manifest = structuredClone(store.head.manifest);
    const configuration = manifest.configurations.find(
      (item) => item.id === manifest.selectedConfigurationId,
    );
    configuration.slots[0] = structuredClone(configuration.systemDisk);
    const snapshot = await store.snapshotFor(manifest);
    // Authenticate before any live-media publication. This prepared checker
    // executes no guest instructions and is disposed before the real swap.
    checked = await prepareSavedMachineRuntime({
      snapshot,
      TriptychCpu,
      deployment: await runtimeDeployment(manifest),
      guardSystemDisk: true,
    });
    checked.dispose();
    checked = undefined;
    if (machine) {
      await insertLibraryBinding(
        configuration.slots[0],
        snapshot.slots[0].bytes,
        { slot: 0, restoreSystem: true },
      );
    } else {
      libraryBusy = true;
      await publishInitial({ manifest, newBlobs: new Map() }, store.head.token);
      activateMachine(startupRuntime);
      startupRuntime = undefined;
      startupSystemRecovery = false;
      connectWorkspace();
      resumeMachine();
      libraryBusy = false;
      libraryReady.checked = false;
      await renderLibrary();
      controls();
    }
  } catch (error) {
    checked?.dispose();
    startupRuntime?.dispose();
    startupRuntime = undefined;
    libraryError(error);
  }
});

async function publishInitial(candidate, token) {
  const snapshot = await store.snapshotFor(
    candidate.manifest,
    candidate.newBlobs,
  );
  const configuration = candidate.manifest.configurations.find(
    (item) => item.id === candidate.manifest.selectedConfigurationId,
  );
  const prepared = await prepareSavedMachineRuntime({
    snapshot,
    TriptychCpu,
    writable: !!writer.owned,
    slotWritable: configuration.slots.map(
      (slot) => slot?.kind === "personal" && slot.writable,
    ),
    deployment: await runtimeDeployment(candidate.manifest),
    guardSystemDisk: snapshot.schema === "triptych-drive-set-v4",
  });
  try {
    startupRuntime?.dispose();
  } catch (error) {
    prepared.dispose();
    throw error;
  }
  startupRuntime = prepared;
  const publication = await store.authority.commitChange(
    token,
    crypto.randomUUID(),
    candidate.manifest,
    candidate.newBlobs,
  );
  if (publication.status !== "committed")
    throw new Error("Initial disk-box publication was superseded.");
  const loaded = await refreshCommitted();
  requireExactPublication(publication, loaded, snapshot);
  return loaded;
}

function requireExactPublication(publication, loaded, snapshot) {
  if (
    publication.status !== "committed" ||
    loaded.kind !== "ready" ||
    loaded.token.kind !== publication.token.kind ||
    loaded.token.revision !== publication.token.revision ||
    loaded.token.digest !== publication.token.digest ||
    loaded.receipt?.operationId !== publication.receipt?.operationId ||
    !sameDiskBoxView(loaded.snapshot, snapshot)
  )
    throw new Error(
      "Disk-box authority changed before activation; reload for recovery.",
    );
}

async function resolveMissingLocalConfiguration(requestedId, initial) {
  const panel = document.querySelector("#local-configuration-resolution");
  const messageElement = document.querySelector(
    "#local-configuration-resolution-message",
  );
  const choice = document.querySelector("#local-configuration-choice");
  const openButton = document.querySelector("#resolve-local-configuration");
  const createButton = document.querySelector("#create-local-configuration");
  choice.replaceChildren();
  if (initial.kind === "ready") {
    for (const saved of initial.manifest.configurations) {
      const option = document.createElement("option");
      option.value = saved.id;
      option.textContent = saved.name + " · " + saved.id.slice(0, 8);
      choice.append(option);
    }
  }
  openButton.disabled = choice.options.length === 0;
  messageElement.textContent =
    `Configuration ${requestedId.slice(0, 8)} is not saved in this browser. ` +
    "The machine is stopped and nothing has been published. Choose an exact saved configuration, or explicitly create a new independent setup. Creating cannot recover the missing configuration's private disks.";
  panel.hidden = false;
  showLibraryView();
  setStatus("Choose a saved configuration or create a new setup.");
  setSaveStatus("Machine has not started; saved data is unchanged.", "idle");

  const controller = new AbortController();
  let resolution;
  try {
    resolution = await new Promise((resolve, reject) => {
      const act = async (action) => {
        openButton.disabled = true;
        createButton.disabled = true;
        let publicationStarted = false;
        let authorityCheckComplete = false;
        let authorityFailed = false;
        try {
          const current = await refreshCommitted();
          authorityCheckComplete = true;
          if (current.kind === "recovery") {
            authorityFailed = true;
            throw new Error(current.error);
          }
          if (action === "open") {
            const id = choice.value;
            if (
              current.kind !== "ready" ||
              !current.manifest.configurations.some((item) => item.id === id)
            )
              throw new Error(
                "Selected device-local configuration is no longer available.",
              );
            if (id !== current.manifest.selectedConfigurationId) {
              if (!writer.owned)
                throw new Error(
                  "Close the owning tab and reload before changing device-local configuration.",
                );
              const manifest = structuredClone(current.manifest);
              manifest.selectedConfigurationId = id;
              publicationStarted = true;
              const stored = await publishInitial(
                { manifest, newBlobs: new Map() },
                current.token,
              );
              resolve({ selected: id, stored });
            } else {
              resolve({ selected: id, stored: current });
            }
          } else {
            if (!writer.owned)
              throw new Error(
                "Close the owning tab and reload before creating a device-local configuration.",
              );
            const base =
              current.kind === "ready" ? current.manifest : emptyDiskBox();
            const candidate = await prepareDiskBoxRecipeLaunch(
              base,
              await libraryRecipe("starter"),
              { freshInstance: true },
            );
            publicationStarted = true;
            const stored = await publishInitial(candidate, current.token);
            resolve({
              selected: candidate.manifest.selectedConfigurationId,
              stored,
            });
          }
        } catch (error) {
          if (
            action === "open" &&
            error.code === "SYSTEM_DISK_RESTORE_REQUIRED"
          ) {
            messageElement.textContent =
              `Could not open that saved configuration: ${message(error)} ` +
              "The current configuration remains selected. Choose another configuration or create a new independent setup.";
            openButton.disabled = choice.options.length === 0;
            createButton.disabled = false;
            return;
          }
          if (
            publicationStarted ||
            !authorityCheckComplete ||
            authorityFailed
          ) {
            reject(error);
            return;
          }
          messageElement.textContent =
            `Could not complete that choice: ${message(error)} ` +
            "The machine remains stopped and no publication was attempted. Choose again or reload.";
          openButton.disabled = choice.options.length === 0;
          createButton.disabled = false;
        }
      };
      openButton.addEventListener("click", () => void act("open"), {
        signal: controller.signal,
      });
      createButton.addEventListener("click", () => void act("create"), {
        signal: controller.signal,
      });
    });
  } finally {
    controller.abort();
    panel.hidden = true;
  }
  history.replaceState(
    null,
    "",
    localConfigurationBookmark(resolution.selected),
  );
  showComputerView();
  return resolution;
}

async function adoptHistoricalDiskBox(stored) {
  if (!writer.owned)
    throw new Error("Close the owning tab and reload to adopt this disk box.");
  const adoptButton = document.querySelector("#adopt-disks");
  const updatePanel = document.querySelector("#saved-machine-update");
  updatePanel.hidden = false;
  showLibraryView();
  setStatus("Update needed before startup.");
  await new Promise((resolve) =>
    adoptButton.addEventListener("click", resolve, { once: true }),
  );
  updatePanel.hidden = true;
  const candidate = await prepareSavedMachineAdoption(
    stored.historical.snapshot,
    { configurationId: crypto.randomUUID(), name: "My saved machine" },
  );
  const adopted = await publishInitial(candidate, stored.token);
  showComputerView();
  return adopted;
}

function selectedDirectLaunch(route) {
  if (!route.has("disk")) return undefined;
  if (
    route.getAll("disk").length !== 1 ||
    [...route.keys()].some((key) => key !== "disk")
  )
    throw new Error("Use one software link without other machine options.");
  return route.get("disk");
}

async function startDirectLaunch(route) {
  const id = selectedDirectLaunch(route);
  await init();
  await loadDeployment();
  const launch = await loadDirectLaunch({
    deployment,
    id,
    baseUrl: document.baseURI,
  });
  const slots = Array.from({ length: launch.configuredCount }, () => null);
  slots[0] = {
    instanceId: crypto.randomUUID(),
    name: launch.name,
    bytes: launch.image,
  };
  const snapshot = {
    schema: "triptych-drive-set-v4",
    configuredCount: launch.configuredCount,
    bootstrap: { profile: launch.profile, bytes: launch.bootstrap },
    slots,
  };
  startupRuntime = await prepareSavedMachineRuntime({
    snapshot,
    TriptychCpu,
    writable: false,
    slotWritable: slots.map(() => false),
    deployment,
    guardSystemDisk: true,
  });
  directSession = true;
  directInstruction =
    launch.id === "advent"
      ? "Colossal Cave is in drive A. Type ADVENT."
      : `Games are in drive A. ${launch.instruction}.`;
  document.body.classList.add("direct-launch");
  document.title = `${launch.name} — Triptych`;
  document.querySelector("main > header h1").textContent = launch.name;
  document.querySelector("#open-library").hidden = true;
  filesButton.hidden = true;
  document.querySelector("#retry-save").hidden = true;
  saveStatusElement.hidden = true;
  activateMachine(startupRuntime);
  startupRuntime = undefined;
  resumeMachine();
  controls();
  terminalElement.focus({ preventScroll: true });
}

try {
  const route = new URL(location.href).searchParams;
  if (route.has("disk")) {
    await startDirectLaunch(route);
  } else {
    await resumeInterruptedStartFresh();
    let localConfiguration = localConfigurationSelection(route);
    writer = await acquireDiskWriter({ name: `${storageName}:disk-writer` });
    const options = {
      name: storageName,
      lease: { isOwner: () => !!writer.owned },
      onBlocked: (text) => setSaveStatus(text, "error"),
    };
    store = await openDiskBoxAppStore(options);
    let stored = await refreshCommitted();
    if (
      stored.kind === "recovery" &&
      /historical bootstrap required/i.test(stored.error)
    ) {
      const historical = await defaultBootstrap();
      store.close();
      store = await openDiskBoxAppStore({
        ...options,
        legacyBootstrap: historical,
      });
      stored = await refreshCommitted();
    }
    if (stored.kind === "recovery") throw new Error(stored.error);
    // Historical snapshots boot from their own bytes immediately. Optional new
    // deployment/tool/catalogue metadata is loaded only after activation below.
    await init();
    if (
      localConfiguration &&
      stored.kind === "unadopted" &&
      stored.historical.kind === "ready"
    )
      stored = await adoptHistoricalDiskBox(stored);
    if (
      localConfiguration &&
      (stored.kind !== "ready" ||
        !stored.manifest.configurations.some(
          (item) => item.id === localConfiguration,
        ))
    ) {
      const resolution = await resolveMissingLocalConfiguration(
        localConfiguration,
        stored,
      );
      localConfiguration = resolution.selected;
      stored = resolution.stored;
    }
    if (stored.kind === "recovery") throw new Error(stored.error);
    if (route.has("recipe")) {
      await previewRequestedRecipe({
        id: route.get("recipe"),
        revision: route.get("revision"),
      });
    }
    if (stored.kind === "unadopted") {
      if (stored.historical.kind === "ready") {
        stored = await adoptHistoricalDiskBox(stored);
      } else {
        if (!writer.owned)
          throw new Error(
            "Close the owning tab and reload to create this disk box.",
          );
        const candidate = await prepareDiskBoxRecipeLaunch(
          emptyDiskBox(),
          requestedRecipe ?? (await libraryRecipe("starter")),
        );
        await publishInitial(candidate, stored.token);
      }
    }
    if (
      localConfiguration &&
      localConfiguration !== store.head.manifest.selectedConfigurationId
    ) {
      if (!writer.owned)
        throw new Error(
          "Close the owning tab before selecting a device-local configuration.",
        );
      if (
        !confirm(
          "Open this device-local configuration? Every other configuration and personal disk will be retained.",
        )
      )
        throw new Error("Device-local configuration activation cancelled.");
      const manifest = structuredClone(store.head.manifest);
      manifest.selectedConfigurationId = localConfiguration;
      try {
        await publishInitial(
          { manifest, newBlobs: new Map() },
          store.head.token,
        );
      } catch (error) {
        if (error.code === "SYSTEM_DISK_RESTORE_REQUIRED")
          throw new Error(
            "The requested local configuration needs its retained system disk restored before it can boot. The selected configuration has not changed.",
          );
        throw error;
      }
    }
    startupRuntime ??= await prepareMachine(committed.snapshot);
    activateMachine(startupRuntime);
    startupRuntime = undefined;
    connectWorkspace();
    resumeMachine();
    setSaveStatus(
      writer.owned
        ? "Saved in this browser"
        : "Read-only tab: disk writes are disabled. Close the owning tab and reload for write access.",
      writer.owned ? "saved" : "idle",
    );
    controls();
    terminalElement.focus({ preventScroll: true });
    void renderLibrary().catch(libraryError);
    if (new URL(location.href).searchParams.has("recipe")) {
      showLibraryView();
      libraryStatus.textContent = "A shared setup is ready to use.";
    }
    try {
      if (!deployment) await loadDeployment();
      const response = await fetch("tool-catalog.json", {
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw new Error("Could not load tool-catalog.json.");
      catalog = await response.json();
      validateToolCatalog(catalog, deployment.distribution);
    } catch (error) {
      catalog = undefined;
      console.warn("Tool updates unavailable", error);
    } finally {
      controls();
      if (deployment) void renderLibrary().catch(libraryError);
    }
  }
} catch (error) {
  try {
    startupRuntime?.dispose();
  } catch (cleanupError) {
    console.warn("Prepared startup cleanup failed", cleanupError);
  }
  startupRuntime = undefined;
  if (
    error.code === "SYSTEM_DISK_RESTORE_REQUIRED" &&
    store?.head?.kind === "ready"
  ) {
    showSystemRecovery();
    await renderLibrary().catch(libraryError);
    await rawRecovery().catch((cause) =>
      console.warn("Raw recovery unavailable", cause),
    );
  } else {
    setStatus(
      `Recovery required: ${message(error)}. Saved data has not been replaced.`,
      "error",
    );
    setSaveStatus(
      "Machine could not start. Open Library, then Backup and recovery, to download available saved data.",
      "error",
    );
    await rawRecovery().catch((cause) =>
      console.warn("Raw recovery unavailable", cause),
    );
  }
  controls();
}
