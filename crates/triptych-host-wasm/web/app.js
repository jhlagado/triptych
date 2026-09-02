import init, { TriptychCpu } from "./triptych_host_wasm.js";
import {
  inputTypeToBytes,
  keyEventToBytes,
  renderTerminal,
  TerminalBuffer,
  textInputToBytes,
} from "./terminal.js";

const CCP_SYSTEM_OFFSET = 0x0000;
const BDOS_SYSTEM_OFFSET = 0x0800;
const BIOS_SYSTEM_OFFSET = 0x1600;
const BACKING_SECTOR_BYTES = 512;

const terminalElement = document.querySelector("#terminal");
const statusElement = document.querySelector("#status");
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

// The layout viewport is inconsistent across mobile browsers once the software
// keyboard opens. VisualViewport is the space the user can actually see.
function syncVisualViewport() {
  const viewport = window.visualViewport;
  const height = viewport?.height ?? window.innerHeight;
  const width = viewport?.width ?? window.innerWidth;
  const offsetTop = viewport?.offsetTop ?? 0;
  const offsetLeft = viewport?.offsetLeft ?? 0;
  const style = document.documentElement.style;
  style.setProperty("--visual-viewport-height", `${height}px`);
  style.setProperty("--visual-viewport-width", `${width}px`);
  style.setProperty("--visual-viewport-offset-top", `${offsetTop}px`);
  style.setProperty("--visual-viewport-offset-left", `${offsetLeft}px`);
}

function setKeyboardOpen(open) {
  document.body.classList.toggle("terminal-keyboard-open", open);
  showKeyboardButton.textContent = open ? "Done" : "Keyboard";
  showKeyboardButton.setAttribute("aria-pressed", String(open));
  syncVisualViewport();
}

function stopMachine(error) {
  runGeneration += 1;
  machine = undefined;
  resetButton.disabled = true;
  downloadButton.disabled = true;
  setStatus(
    "Machine stopped after a WebAssembly fault. Reload the page to restart.",
    "error",
  );
  console.error("Triptych WebAssembly machine stopped", error);
}

function enqueueInput(bytes) {
  if (machine === undefined || bytes.length === 0) return false;
  try {
    machine.enqueue_serial_input(bytes);
    return true;
  } catch (error) {
    stopMachine(error);
    return false;
  }
}

function focusMobileInput() {
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

function renderOutput() {
  const output = machine?.take_serial_output();
  if (output?.length > 0) {
    terminal.write(output);
    renderTerminal(terminalElement, terminal.snapshot());
  }
}

function runMachine(generation) {
  if (machine === undefined || generation !== runGeneration) return;
  try {
    const deadline = performance.now() + 6;
    do {
      machine.run_slice(25_000, 250_000);
    } while (performance.now() < deadline);
    renderOutput();
  } catch (error) {
    stopMachine(error);
    return;
  }
  requestAnimationFrame(() => runMachine(generation));
}

function workingDisk(source) {
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

function boot(source, name) {
  const disk = workingDisk(source);
  runGeneration += 1;
  machine?.free();
  machine = new TriptychCpu(bootRom);
  machine.install_drive(0, disk, true);
  machine.reset();
  terminal.clear();
  renderTerminal(terminalElement, terminal.snapshot());
  diskName = name.replace(/\.(dsk|img)$/iu, "") + "-triptych.img";
  resetButton.disabled = false;
  downloadButton.disabled = false;
  setStatus(
    `Running ${name}; click or tap the terminal and type at A>.`,
    "running",
  );
  terminalElement.focus();
  const generation = runGeneration;
  requestAnimationFrame(() => runMachine(generation));
}

async function bootFromUrl(url, name) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${name}.`);
  boot(new Uint8Array(await response.arrayBuffer()), name);
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

diskInput.addEventListener("change", async () => {
  const [file] = diskInput.files;
  if (file === undefined) return;
  try {
    boot(new Uint8Array(await file.arrayBuffer()), file.name);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
});

resetButton.addEventListener("click", () => {
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
  const bytes = machine.export_drive(0);
  const link = document.createElement("a");
  link.href = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  link.download = diskName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  terminalElement.focus();
});

try {
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
  if (configuration.diskUrl === null) {
    setStatus("Choose a CP/M disk image to start.");
  } else {
    await bootFromUrl(configuration.diskUrl, configuration.diskName);
  }
} catch (error) {
  setStatus(error instanceof Error ? error.message : String(error), "error");
}
