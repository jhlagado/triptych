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
import { openRevisionedDiskStore } from "./working-disk-revisions.js";
import { prepareSourceBundle, mapSourceBundleOffset } from "./source-bundle.js";
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

let machine;
let bootRom;
let ccp;
let bdos;
let bios;
let diskName = "triptych-cpm22.img";
let runGeneration = 0;
let controlPending = false;
let machineRunning = false;
let workspace;
let store;
let writer;
let committed;
let lastFlushCount = 0;
let savePending = false;
let saveAgain = false;
let managementToken;
let stagedDisk;
let panelGeneration = 0;
let stageGeneration = 0;
let managementAttempt = 0;
let diagnosticAttempt = 0;
let catalog;
let deployment;
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

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
function controls() {
  const running = machineRunning && workspace?.canRun;
  resetButton.disabled = !running || filesDialog.open;
  downloadButton.disabled = !committed;
  recoveryDownload.disabled = !machine;
  const managing = workspace?.state === "managing";
  beginButton.disabled =
    !running || !writer?.owned || !savedAcknowledgment.checked;
  recoveryButton.disabled =
    workspace?.state !== "running" ||
    !writer?.owned ||
    !discardAcknowledgment.checked;
  importInput.disabled = !managing;
  diskInput.disabled = !managing;
  prepareBuildButton.disabled = !managing;
  starterButton.disabled = !managing || !deployment;
  commitButton.disabled =
    !managementToken ||
    !stagedDisk ||
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

// Coalesce frame notifications while a save is in flight. The coordinator owns
// ordering with manual changes; it captures each submitted snapshot itself.
async function saveCheckpoint() {
  if (!workspace?.canRun || !writer?.owned) return;
  if (savePending) {
    saveAgain = true;
    return;
  }
  savePending = true;
  setSaveStatus("Saving the working disk in this browser…", "saving");
  try {
    do {
      saveAgain = false;
      await workspace.saveCheckpoint({
        name: diskName,
        bytes: machine.export_drive_checkpoint(0),
      });
    } while (saveAgain && workspace.canRun);
    retrySave.hidden = true;
    setSaveStatus("Working disk saved in this browser.", "saved");
  } catch (error) {
    saveFailed(error);
  } finally {
    savePending = false;
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
    const flushCount = machine.drive_flush_count(0);
    if (flushCount !== lastFlushCount) {
      lastFlushCount = flushCount;
      void saveCheckpoint();
    }
  } catch (error) {
    stopMachine(error);
    return;
  }
  requestAnimationFrame(() => runMachine(generation));
}

function adaptedDisk(source) {
  if (source.length < BIOS_SYSTEM_OFFSET + bios.length) {
    throw new Error("The selected image has no complete CP/M BIOS slot.");
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

function prepareMachine({ bytes, name }) {
  const cpu = new TriptychCpu(bootRom);
  try {
    cpu.install_drive(0, bytes, !!writer?.owned);
    cpu.reset();
    return { cpu, name };
  } catch (error) {
    cpu.free();
    throw error;
  }
}

function activateMachine(prepared) {
  const previous = machine;
  machine = prepared.cpu;
  diskName = prepared.name;
  lastFlushCount = machine.drive_flush_count(0);
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
    `Running ${diskName}${writer?.owned ? "" : " (read-only tab)"}; click or tap the terminal and type at A>.`,
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
  if (committed) download(committed.bytes, committed.name);
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
  if (machine)
    download(machine.export_drive_checkpoint(0), `checkpoint-${diskName}`);
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
  stagedDisk = undefined;
  importInput.value = "";
  diskInput.value = "";
}
function currentToken(token) {
  if (token !== managementToken || !token)
    throw new Error("This disk-management session has ended.");
  return workspace.inspect(token);
}

function stagingRequest() {
  const token = managementToken;
  currentToken(token);
  const generation = ++stageGeneration;
  return {
    token,
    check() {
      currentToken(token);
      if (generation !== stageGeneration)
        throw new Error("A newer staging action superseded this request.");
    },
  };
}

async function renderFiles() {
  const generation = ++panelGeneration;
  fileList.replaceChildren();
  backupList.replaceChildren();
  toolsList.replaceChildren();
  const snapshot = managementToken
    ? workspace.inspect(managementToken)
    : committed;
  if (snapshot) {
    document.querySelector("#disk-summary").textContent =
      `${snapshot.name} · committed revision ${snapshot.revision}. Downloads include CP/M record padding.`;
    let disk;
    try {
      disk = new CpmDisk(snapshot.bytes);
      const names = disk.file_names();
      for (const name of names) {
        const row = document.createElement("li");
        row.textContent = `${name} · ${disk.file_records(name) * 128} bytes${disk.file_read_only(name) ? " · read-only" : ""} `;
        const bytes = disk.read_file(name);
        row.append(button("Download", () => download(bytes, name)));
        fileList.append(row);
      }
      document.querySelector("#disk-summary").textContent +=
        ` Free: ${disk.free_bytes()} bytes, ${disk.free_directory_entries()} directory entries.`;
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
    document.querySelector("#disk-summary").textContent =
      "No committed working disk is available.";
  if (!store) return;
  try {
    const backups = await store.listBackups();
    if (generation !== panelGeneration) return;
    for (const backup of backups) {
      const row = document.createElement("li");
      row.textContent = `${backup.name} · revision ${backup.revision} `;
      row.append(
        button("Download backup", async () => {
          const value = await store.readBackup(backup.operationId);
          if (!value) throw new Error("Backup is unavailable.");
          download(value.bytes, `backup-r${value.revision}-${value.name}`);
        }),
      );
      const restore = button("Stage restore", async () => {
        const request = stagingRequest();
        const value = await store.readBackup(backup.operationId);
        request.check();
        if (!value) throw new Error("Backup is unavailable.");
        if (
          !confirm(
            "Stage this exact backup? Applying it will restart CP/M and back up the current disk.",
          )
        )
          return;
        workspace.stage(request.token, value);
        stagedDisk = value;
        filesStatus.textContent = `Backup revision ${value.revision} staged. Apply and restart to restore it.`;
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
  const candidate = stagedDisk ?? baseline;
  const disk = new CpmDisk(candidate.bytes);
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
    const value = { name: candidate.name, bytes: disk.export_candidate() };
    currentToken(token);
    workspace.stage(token, value);
    stagedDisk = value;
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
  if (!file) return;
  try {
    const request = stagingRequest();
    let bytes = new Uint8Array(await file.arrayBuffer());
    request.check();
    if (adapt) {
      if (
        !confirm(
          "Adapt this image by replacing its CCP, BDOS and BIOS with this Triptych release? Leave this unchecked for exact recovery.",
        )
      )
        return;
      bytes = adaptedDisk(bytes);
    }
    // Geometry and directory checks apply to Files, but exact whole-disk
    // recovery may legitimately contain an unsupported guest filesystem.
    const value = { name: file.name, bytes };
    workspace.stage(request.token, value);
    stagedDisk = value;
    filesStatus.textContent = `Staged exact disk ${file.name}${adapt ? " with explicit system adaptation" : ""}. Apply will back up and restart.`;
    controls();
  } catch (error) {
    panelError(error);
  } finally {
    diskInput.value = "";
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
    disk = new CpmDisk((stagedDisk ?? baseline).bytes);
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
    ? (stagedDisk ?? currentToken(managementToken)).bytes
    : machine
      ? machine.export_drive_checkpoint(0)
      : committed?.bytes;
}

document
  .querySelector("#locate-diagnostic")
  .addEventListener("click", async () => {
    let disk;
    const attempt = ++diagnosticAttempt;
    const panel = panelGeneration;
    const stage = stageGeneration;
    const token = managementToken;
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
      committed = await store.load();
      await renderFiles();
    } catch (error) {
      panelError(error);
    }
    controls();
  }
});

try {
  // Recovery storage does not depend on a working emulator or boot download.
  writer = await acquireDiskWriter();
  store = await openRevisionedDiskStore({
    onBlocked: (text) => setSaveStatus(text, "error"),
  });
  committed = await store.load();
  await init();
  [bootRom, ccp, bdos, bios] = await Promise.all(
    ["bootstrap.bin", "ccp.bin", "bdos.bin", "bios.bin"].map(async (name) => {
      const response = await fetch(name, { cache: "no-store" });
      if (!response.ok) throw new Error(`Could not load ${name}.`);
      return new Uint8Array(await response.arrayBuffer());
    }),
  );
  const configuration = await fetch("config.json", { cache: "no-store" }).then(
    (response) => response.json(),
  );
  // Corrupt saved data has already failed closed; never seed over it.
  let initial = committed;
  if (!initial) {
    if (configuration.diskUrl === null)
      throw new Error("No saved disk or distribution disk is available.");
    const response = await fetch(configuration.diskUrl, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the distribution disk.");
    initial = {
      name: configuration.diskName,
      bytes: new Uint8Array(await response.arrayBuffer()),
    };
    if (writer.owned) committed = await store.saveCheckpoint(0, initial);
  }
  activateMachine(prepareMachine(initial));
  const coordinatedStore = {
    ...store,
    async saveCheckpoint(revision, value) {
      const receipt = await store.saveCheckpoint(revision, value);
      committed = receipt;
      return receipt;
    },
  };
  workspace = createDiskWorkspace({
    store: coordinatedStore,
    writer,
    revision: committed?.revision ?? 0,
    runtime: {
      pause: pauseMachine,
      resume: resumeMachine,
      ready: () => machine.disk_management_ready(),
      checkpoint: () => ({
        name: diskName,
        bytes: machine.export_drive_checkpoint(0),
      }),
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
  const legacy = await store?.loadLegacyRecord().catch(() => undefined);
  if (legacy?.bytes) {
    document.querySelector("#legacy-recovery").hidden = false;
    document.querySelector("#legacy-recovery").onclick = () =>
      download(legacy.bytes, "legacy-recovery.img");
  }
  controls();
}
