// A headless Triptych CP/M 2.2 machine for Node.
//
//   const disk = createDisk();
//   disk.addFiles([["HELLO.COM", bytes]]);
//   const machine = bootMachine([disk.image()]);
//   const reply = machine.run("HELLO");
//   const after = machine.disk(0).readFile("OUTPUT.TXT");
//   machine.close();
//
// Pass { diskTiming: { profile: "8in-sssd" } } to bootMachine to learn how
// long the same disk activity would take on a mechanical floppy drive.
//
// Disks use Triptych's 2 MB format: 2,048-byte blocks and 1,024 directory
// entries, with the N04 resident system in the first 16K.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CpmDisk, TriptychCpu } = require("../dist/wasm/triptych_host_wasm.js");
const boot = readFileSync(new URL("../dist/boot.bin", import.meta.url));
const system = readFileSync(new URL("../dist/system.bin", import.meta.url));

export const SYSTEM_PROFILE = "triptych-cpu-v0.1-2m-n04";
export const DISK_TIMING_PROFILES = Object.freeze(["8in-sssd", "5in-dsdd", "3in-dsdd"]);
const DEFAULT_CLOCK_HZ = 4_000_000;
const PROMPT = /\r\n[A-P]>$/;
const SLICE_STEPS = 50_000;
const SLICE_TSTATES = 500_000;

// Run fn with a wasm-bindgen object and always free it.
function using(object, fn) {
  try {
    return fn(object);
  } finally {
    object.free();
  }
}

function blankImage() {
  return using(CpmDisk.create_two_mib(), (blank) => blank.migrate_to_two_mib(system));
}

// One 2 MB CP/M disk image. Each change produces a fresh image.
export class TriptychDisk {
  #image;

  constructor(image = blankImage()) {
    this.#image = Uint8Array.from(image);
    using(new CpmDisk(this.#image), () => {});
  }

  // Add or replace files, given as [name, bytes] pairs in CP/M 8.3 form.
  addFiles(files) {
    this.#image = using(new CpmDisk(this.#image), (disk) => {
      for (const [name, bytes] of files) disk.add_import(name, bytes);
      return disk.export_candidate();
    });
    return this;
  }

  addFile(name, bytes) {
    return this.addFiles([[name, bytes]]);
  }

  // Return a file's bytes in whole 128-byte records, or undefined if absent.
  readFile(name) {
    return using(new CpmDisk(this.#image), (disk) => {
      const canonical = CpmDisk.canonical_name(name);
      return disk.file_names().includes(canonical) ? disk.read_file(canonical) : undefined;
    });
  }

  fileNames() {
    return using(new CpmDisk(this.#image), (disk) => disk.file_names());
  }

  freeBytes() {
    return using(new CpmDisk(this.#image), (disk) => disk.free_bytes());
  }

  freeDirectoryEntries() {
    return using(new CpmDisk(this.#image), (disk) => disk.free_directory_entries());
  }

  image() {
    return Uint8Array.from(this.#image);
  }
}

export function createDisk(files = []) {
  return new TriptychDisk().addFiles(files);
}

// A booted machine at the A> prompt with images in drives A:, B: and so on.
export class TriptychMachine {
  #cpu;
  #seen = 0;

  constructor(images, { maximumSlices = 10_000, diskTiming } = {}) {
    if (images.length < 1 || images.length > 16) throw new RangeError("give between 1 and 16 drive images");
    this.#cpu = new TriptychCpu(boot);
    images.forEach((image, drive) => this.#cpu.install_drive(drive, image, true));
    if (diskTiming) this.setDiskTiming(diskTiming);
    this.#runUntil((text) => text.endsWith("A>"), maximumSlices, "the A> prompt");
    this.#seen = this.transcript().length;
  }

  #runUntil(done, maximumSlices, waitingFor) {
    for (let slice = 0; slice < maximumSlices; slice += 1) {
      this.#cpu.run_slice(SLICE_STEPS, SLICE_TSTATES);
      if (done(this.transcript())) return;
    }
    throw new Error(`Triptych timed out waiting for ${waitingFor}: ${JSON.stringify(this.transcript().slice(-200))}`);
  }

  // Type a command line and return everything printed up to the next prompt.
  run(command, { maximumSlices = 1_000_000 } = {}) {
    const start = this.#seen;
    this.#cpu.enqueue_serial_input(new TextEncoder().encode(`${command}\r`));
    this.#runUntil((text) => text.length > start && PROMPT.test(text.slice(start)), maximumSlices, command);
    const text = this.transcript();
    this.#seen = text.length;
    return text.slice(start);
  }

  // Everything the machine has printed since it was switched on.
  transcript() {
    return Buffer.from(this.#cpu.serial_output()).toString("latin1");
  }

  // T-states executed since power-on.
  tstates() {
    return this.#cpu.elapsed_tstates();
  }

  // Model a floppy drive, or pass null for instant media. Counters restart,
  // so calling this just before run() measures one command. In "account"
  // mode (the default) commands still complete at once and delays are only
  // added up; in "stall" mode the guest waits for them in emulated time.
  setDiskTiming(timing) {
    if (!timing) {
      this.#cpu.configure_disk_timing("", false, DEFAULT_CLOCK_HZ);
      return this;
    }
    const { profile, mode = "account", clockHz = DEFAULT_CLOCK_HZ } = timing;
    if (!DISK_TIMING_PROFILES.includes(profile)) {
      throw new RangeError(`disk timing profile must be one of ${DISK_TIMING_PROFILES.join(", ")}`);
    }
    if (mode !== "account" && mode !== "stall") throw new RangeError('disk timing mode must be "account" or "stall"');
    if (!Number.isInteger(clockHz) || clockHz < 1 || clockHz > 0xffff_ffff) {
      throw new RangeError("clockHz must be a positive 32-bit integer");
    }
    this.#cpu.configure_disk_timing(profile, mode === "stall", clockHz);
    return this;
  }

  // What the disk activity since setDiskTiming would cost on the modelled
  // drive, or undefined for instant media. Times are milliseconds.
  diskTimingReport() {
    const report = this.#cpu.disk_timing_report();
    if (!report) return undefined;
    return using(report, (r) => ({
      profile: r.profile(),
      mode: r.stall() ? "stall" : "account",
      clockHz: r.clock_hz(),
      modelledMs: r.modelled_ms(),
      diskMs: r.disk_ms(),
      readyMs: r.ready_ms(),
      seekMs: r.seek_ms(),
      rotationMs: r.rotation_ms(),
      transferMs: r.transfer_ms(),
      recordReads: r.record_reads(),
      recordWrites: r.record_writes(),
      bufferHits: r.buffer_hits(),
      sectorReads: r.sector_reads(),
      sectorWrites: r.sector_writes(),
      seeks: r.seeks(),
      readyWaits: r.ready_waits(),
      maxCylinder: r.max_cylinder(),
      cylinders: r.cylinders(),
    }));
  }

  disk(drive = 0) {
    return new TriptychDisk(this.#cpu.export_drive(drive));
  }

  close() {
    this.#cpu.free();
  }
}

export function bootMachine(images, options) {
  return new TriptychMachine(images, options);
}
