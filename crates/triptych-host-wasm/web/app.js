import init, { TriptychCpu, CpmDisk } from "./triptych_host_wasm.js";
import {
  inputTypeToBytes,
  keyEventToBytes,
  renderTerminal,
  revealTerminalCursor,
  TerminalBuffer,
  textInputToBytes,
} from "./terminal.js";
import { acquireDiskWriter, createDiskWorkspace } from "./disk-workspace.js";
import { openDriveSetStore } from "./drive-set-store.js";
import { fetchPublicDriveSet } from "./public-distribution.js";
import { copyDriveSet, encodeDriveSet, decodeDriveSet } from "./drive-set.js";
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

// A second, explicitly selected machine lets returning visitors play the
// published starter disks without replacing their existing working machine.
// This stable namespace persists game saves across visits and tool releases.
const suppliedMachine =
  new URL(location.href).searchParams.get("machine") === "supplied";
const storageName = suppliedMachine ? "triptych-supplied" : "triptych-cpu";
document.querySelector("#machine-choice").textContent = suppliedMachine
  ? "Supplied A+B machine — its saves are separate from your usual machine."
  : "Your working machine — existing saved disks are preserved.";

let machine;
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

function displayedSet() {
  return managementToken
    ? workspace.inspect(managementToken).snapshot
    : committed?.snapshot;
}
function selectedImage(snapshot) {
  const image = snapshot?.drives[selectedDrive];
  if (!image) throw new Error(`Drive ${selectedDrive} is not attached.`);
  return image;
}
function captureCheckpoint() {
  if (!machine || !activeMedia)
    throw new Error("No running drive set is available.");
  return {
    bootstrap: {
      profile: activeMedia.bootstrap.profile,
      bytes: activeMedia.bootstrap.bytes.slice(),
    },
    drives: {
      A: {
        name: activeMedia.names.A,
        bytes: machine.export_drive_checkpoint(0),
      },
      B:
        activeMedia.names.B === null
          ? null
          : {
              name: activeMedia.names.B,
              bytes: machine.export_drive_checkpoint(1),
            },
    },
  };
}
function stageSet(token, snapshot) {
  workspace.stage(token, snapshot);
  stagedSet = copyDriveSet(snapshot);
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function controls() {
  const running = machineRunning && workspace?.canRun;
  resetButton.disabled = !running || filesDialog.open;
  downloadButton.disabled = !committed?.snapshot.drives[selectedDrive];
  downloadButton.textContent = `Download saved disk ${selectedDrive}`;
  downloadSetButton.disabled = !committed;
  recoveryDownload.disabled =
    !machine || activeMedia?.names[selectedDrive] === null;
  downloadCheckpointSetButton.disabled = !machine;
  const managing = workspace?.state === "managing";
  beginButton.disabled =
    !running || !writer?.owned || !savedAcknowledgment.checked;
  recoveryButton.disabled =
    workspace?.state !== "running" ||
    !writer?.owned ||
    !discardAcknowledgment.checked;
  const snapshot = stagedSet ?? displayedSet();
  const attached = !!snapshot?.drives[selectedDrive];
  importInput.disabled = !managing || !attached;
  diskInput.disabled = !managing;
  setInput.disabled = !managing;
  prepareBuildButton.disabled = !managing || !attached;
  starterButton.disabled = !managing || !deployment || !attached;
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
    !!stagedSet ||
    migrationPending ||
    !deployment?.diskProfiles ||
    snapshot?.bootstrap.profile === "triptych-cpu-v0.1-8m-ab";
  blankBButton.disabled =
    !managing ||
    snapshot?.bootstrap.profile !== "triptych-cpu-v0.1-8m-ab" ||
    !!snapshot?.drives.B;
  removeBButton.disabled = !managing || !snapshot?.drives.B;
  commitButton.disabled =
    !managementToken ||
    !stagedSet ||
    !["managing", "recovery"].includes(workspace?.state);
  cancelButton.disabled =
    !managementToken || !["managing", "preparing"].includes(workspace?.state);
  for (const button of toolsList.querySelectorAll("button"))
    button.disabled = !managing;
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
  setSaveStatus("Saving the working disk in this browser…", "saving");
  try {
    const result = await workspace.saveCheckpoint(captureCheckpoint());
    if (result.kind === "superseded" || request !== saveRequest) return;
    retrySave.hidden = true;
    setSaveStatus("Working disk saved in this browser.", "saved");
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
    !workspace?.canRun ||
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
  if (filesDialog.open || !workspace?.canRun || !machineRunning) return;
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
  if (!machineRunning || !workspace?.canRun || generation !== runGeneration)
    return;
  try {
    const deadline = performance.now() + 6;
    let outputChanged = false;
    do {
      machine.run_slice(25_000, 250_000);
      // A Z80 instruction can emit at most one serial byte. Draining after
      // every bounded slice caps the transient WASM output batch at 25,000
      // bytes even if several slices fit in one animation frame.
      outputChanged = drainOutput() || outputChanged;
    } while (performance.now() < deadline);
    if (outputChanged) {
      renderTerminal(terminalElement, terminal.snapshot());
      revealActiveCursor();
    }
    const counts = [
      machine.drive_flush_count(0),
      activeMedia.names.B === null ? 0 : machine.drive_flush_count(1),
    ];
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

function prepareMachine(value) {
  const snapshot = copyDriveSet(value);
  const cpu = new TriptychCpu(snapshot.bootstrap.bytes);
  try {
    cpu.install_drive(0, snapshot.drives.A.bytes, !!writer?.owned);
    if (snapshot.drives.B)
      cpu.install_drive(1, snapshot.drives.B.bytes, !!writer?.owned);
    cpu.reset();
    return {
      cpu,
      media: {
        bootstrap: snapshot.bootstrap,
        names: {
          A: snapshot.drives.A.name,
          B: snapshot.drives.B?.name ?? null,
        },
      },
    };
  } catch (error) {
    cpu.free();
    throw error;
  }
}

function activateMachine(prepared) {
  const previous = machine;
  machine = prepared.cpu;
  activeMedia = prepared.media;
  lastFlushCounts = [
    machine.drive_flush_count(0),
    activeMedia.names.B === null ? 0 : machine.drive_flush_count(1),
  ];
  terminal.clear();
  renderTerminal(terminalElement, terminal.snapshot());
  previous?.free();
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
  setStatus(
    `Running A: ${activeMedia.names.A}${activeMedia.names.B === null ? "" : ` · B: ${activeMedia.names.B}`}${writer?.owned ? "" : " (read-only tab)"}; click or tap the terminal and type at A>.`,
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
  if (!machineRunning || !workspace?.canRun || filesDialog.open) return;
  machine.reset();
  terminal.clear();
  renderTerminal(terminalElement, terminal.snapshot());
  setStatus(
    "Machine reset; disk contents and flushed writes were retained.",
    "running",
  );
  terminalElement.focus();
});

downloadButton.addEventListener("click", () => {
  const disk = committed?.snapshot.drives[selectedDrive];
  if (disk) download(disk.bytes, disk.name);
});
downloadSetButton.addEventListener("click", async () => {
  try {
    if (committed)
      download(await encodeDriveSet(committed.snapshot), "triptych-drives.tds");
  } catch (error) {
    panelError(error);
  }
});
downloadCheckpointSetButton.addEventListener("click", async () => {
  try {
    download(
      await encodeDriveSet(captureCheckpoint()),
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
  if (machine && activeMedia.names[selectedDrive] !== null)
    download(
      machine.export_drive_checkpoint(selectedDrive === "A" ? 0 : 1),
      `checkpoint-${activeMedia.names[selectedDrive]}`,
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
  selectedDrive = driveSelect.value === "B" ? "B" : "A";
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
  if (!id.startsWith("v2:")) return store.readBackup(id);
  const bootstrap = await defaultBootstrap();
  const reader = await openDriveSetStore({
    name: storageName,
    legacyBootstrap: bootstrap,
  });
  try {
    return await reader.readBackup(id);
  } finally {
    reader.close();
  }
}

async function renderFiles() {
  const generation = ++panelGeneration;
  displayedGeometry = undefined;
  fileList.replaceChildren();
  backupList.replaceChildren();
  toolsList.replaceChildren();
  const set = displayedSet();
  const snapshot = set?.drives[selectedDrive];
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
        ` Geometry: ${displayedGeometry === "ibm3740" ? "legacy IBM 3740" : "8 MiB"}. Free: ${disk.free_bytes()} bytes, ${disk.free_directory_entries()} directory entries.`;
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
      ? `Drive ${selectedDrive} is not attached. Enable A/B and stage a blank B or an eight MiB image.`
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
          const disk = value.drives[drive];
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
            await encodeDriveSet(value),
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
    const value = copyDriveSet(candidate);
    value.drives[selectedDrive] = {
      name: image.name,
      bytes: disk.export_candidate(),
    };
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
    const candidate = copyDriveSet(stagedSet ?? currentToken(request.token));
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
    candidate.drives[request.drive] = { name: file.name, bytes };
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
    const value = copyDriveSet(baseline);
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
    const value = copyDriveSet(baseline);
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
    const value = copyDriveSet(stagedSet ?? currentToken(token));
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
    const value = copyDriveSet(stagedSet ?? currentToken(token));
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
    const value = await decodeDriveSet(
      new Uint8Array(await file.arrayBuffer()),
    );
    request.check();
    if (
      !confirm(
        "Stage this complete saved set, including its exact bootstrap and A/B images? Apply backs up the current set and restarts.",
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
    ? (stagedSet ?? currentToken(managementToken)).drives[selectedDrive]?.bytes
    : machine
      ? activeMedia.names[selectedDrive] === null
        ? undefined
        : machine.export_drive_checkpoint(selectedDrive === "A" ? 0 : 1)
      : committed?.snapshot.drives[selectedDrive]?.bytes;
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
    setSaveStatus("Working disk saved in this browser.", "saved");
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
  const head = await store
    .readRawRecovery("drive-set-state", "head")
    .catch(() => undefined);
  const target = document.querySelector("#raw-recovery");
  target.replaceChildren();
  if (!head) return;
  target.append(
    button("Download raw saved manifest", () =>
      download(
        new TextEncoder().encode(JSON.stringify(head)),
        "drive-set-head.json",
      ),
    ),
  );
  const refs = [
    ["bootstrap", head.manifest?.bootstrap?.image],
    ["A", head.manifest?.drives?.A?.image],
    ["B", head.manifest?.drives?.B?.image],
  ];
  for (const [name, reference] of refs) {
    if (typeof reference?.sha256 !== "string") continue;
    const raw = await store
      .readRawRecovery("drive-set-blobs", reference.sha256)
      .catch(() => undefined);
    if (raw?.bytes)
      target.append(
        button(`Download raw ${name}`, () =>
          download(raw.bytes, `recovery-${name}.bin`),
        ),
      );
  }
}

try {
  // Recovery storage does not depend on a working emulator or boot download.
  writer = await acquireDiskWriter({ name: `${storageName}:disk-writer` });
  const options = {
    name: storageName,
    onBlocked: (text) => setSaveStatus(text, "error"),
  };
  store = await openDriveSetStore(options);
  let stored = await refreshCommitted();
  if (stored.kind === "recovery") {
    const v3 = await store.readRawRecovery("drive-set-state", "head");
    if (v3 === undefined) {
      // v1/v2 did not store a bootstrap. Supply their historical E400 bootstrap
      // explicitly; leave their source records untouched during this upgrade.
      const historical = await defaultBootstrap();
      store.close();
      store = await openDriveSetStore({
        ...options,
        legacyBootstrap: historical,
      });
      stored = await refreshCommitted();
    }
    if (stored.kind === "recovery") throw new Error(stored.error);
  }
  await init();
  // Corrupt saved data has already failed closed; never seed over it.
  let initial = committed?.snapshot;
  if (!initial) {
    const response = await fetch("config.json", {
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw new Error("Could not load config.json.");
    const configuration = await response.json();
    if (configuration.publicDrives === true) {
      const published = await fetch("deployment-manifest.json", {
        cache: "no-store",
        redirect: "error",
      });
      if (!published.ok)
        throw new Error("Could not load the supplied disk manifest.");
      initial = await fetchPublicDriveSet({
        deployment: await published.json(),
        baseUrl: location.href,
      });
    } else {
      if (configuration.diskUrl === null)
        throw new Error("No saved disk or distribution disk is available.");
      const disk = await fetch(configuration.diskUrl, {
        cache: "no-store",
        redirect: "error",
      });
      if (!disk.ok) throw new Error("Could not load the distribution disk.");
      initial = copyDriveSet({
        bootstrap: { profile: "legacy-e400", bytes: await defaultBootstrap() },
        drives: {
          A: {
            name: configuration.diskName,
            bytes: new Uint8Array(await disk.arrayBuffer()),
          },
          B: null,
        },
      });
    }
    // Validate filesystem structure before publishing either fresh image.
    for (const snapshot of Object.values(initial.drives)) {
      if (!snapshot) continue;
      const candidate = new CpmDisk(snapshot.bytes);
      candidate.free();
    }
    if (writer.owned) {
      await store.saveCheckpoint({ kind: "empty" }, initial);
      await refreshCommitted();
    } else
      committed = {
        kind: "ready",
        token: { kind: "empty" },
        snapshot: initial,
      };
  }
  activateMachine(prepareMachine(initial));
  const coordinatedStore = {
    load: () => store.load(),
    commitChange: (...args) => store.commitChange(...args),
    async saveCheckpoint(token, value) {
      const snapshot = copyDriveSet(value);
      const receipt = await store.saveCheckpoint(token, snapshot);
      committedGeneration += 1;
      committed = {
        kind: "ready",
        token: { kind: "v3", revision: receipt.revision },
        snapshot,
        receipt,
      };
      return receipt;
    },
  };
  workspace = createDiskWorkspace({
    store: coordinatedStore,
    writer,
    token: committed?.token ?? { kind: "empty" },
    runtime: {
      pause: pauseMachine,
      resume: resumeMachine,
      ready: () => machine.disk_management_ready(),
      checkpoint: captureCheckpoint,
      prepare: prepareMachine,
      activate: activateMachine,
      discard: (prepared) => prepared.cpu.free(),
    },
  });
  resumeMachine();
  setSaveStatus(
    writer.owned
      ? "Working disk saved in this browser."
      : "Read-only tab: disk writes are disabled. Close the owning tab and reload for write access.",
    writer.owned ? "saved" : "idle",
  );
  controls();
  terminalElement.focus({ preventScroll: true });
  try {
    [deployment, catalog] = await Promise.all(
      ["deployment-manifest.json", "tool-catalog.json"].map(async (path) => {
        const response = await fetch(path, { cache: "no-store" });
        if (!response.ok) throw new Error(`Could not load ${path}.`);
        return response.json();
      }),
    );
    validateToolCatalog(catalog, deployment.distribution);
  } catch (error) {
    catalog = undefined;
    console.warn("Tool updates unavailable", error);
  } finally {
    controls();
  }
} catch (error) {
  setStatus(
    `Recovery required: ${message(error)}. Saved data has not been replaced.`,
    "error",
  );
  setSaveStatus(
    "Machine could not start. Use Files and recovery to download available saved data.",
    "error",
  );
  await rawRecovery().catch((cause) =>
    console.warn("Raw recovery unavailable", cause),
  );
  controls();
}
