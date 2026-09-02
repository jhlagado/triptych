import init, { TriptychCpu } from "./triptych_host_wasm.js";
import { keyEventToBytes, renderTerminal, TerminalBuffer } from "./terminal.js";

const BDOS_SYSTEM_OFFSET = 0x0800;
const BIOS_SYSTEM_OFFSET = 0x1600;
const BACKING_SECTOR_BYTES = 512;

const terminalElement = document.querySelector("#terminal");
const statusElement = document.querySelector("#status");
const diskInput = document.querySelector("#disk-input");
const resetButton = document.querySelector("#reset");
const downloadButton = document.querySelector("#download");
const terminal = new TerminalBuffer();

let machine;
let bootRom;
let bdos;
let bios;
let diskName = "triptych-cpm22.img";
let runGeneration = 0;

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
  const deadline = performance.now() + 6;
  do {
    machine.run_slice(25_000, 250_000);
  } while (performance.now() < deadline);
  renderOutput();
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
  setStatus(`Running ${name}; click the terminal and type at A>.`, "running");
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
  if (machine === undefined) return;
  const bytes = keyEventToBytes(event);
  if (bytes === undefined) return;
  event.preventDefault();
  machine.enqueue_serial_input(bytes);
});

terminalElement.addEventListener("paste", (event) => {
  if (machine === undefined) return;
  event.preventDefault();
  const text = event.clipboardData.getData("text").replace(/\r?\n/gu, "\r");
  const bytes = Uint8Array.from(
    text,
    (character) => character.charCodeAt(0) & 0xff,
  );
  machine.enqueue_serial_input(bytes);
});

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
  [bootRom, bdos, bios] = await Promise.all(
    ["bootstrap.bin", "bdos.bin", "bios.bin"].map(async (name) => {
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
