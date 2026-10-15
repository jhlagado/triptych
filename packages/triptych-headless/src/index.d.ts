/** The resident system profile on every disk this package creates. */
export const SYSTEM_PROFILE: "triptych-cpu-v0.1-2m-n04";

/** Built-in floppy drives for disk timing. */
export const DISK_TIMING_PROFILES: readonly DiskTimingProfile[];

/**
 * 8-inch IBM 3740 single density (CP/M's original format), 5.25-inch or
 * 3.5-inch double density with 512-byte sectors.
 */
export type DiskTimingProfile = "8in-sssd" | "5in-dsdd" | "3in-dsdd";

export interface DiskTimingOptions {
  profile: DiskTimingProfile;
  /**
   * "account" (default): commands complete at once and delays are only
   * added up. "stall": the guest waits for each delay in emulated time.
   */
  mode?: "account" | "stall";
  /** Guest clock for converting mechanical times. Default 4,000,000. */
  clockHz?: number;
}

/** Disk activity since timing was configured. Times are milliseconds. */
export interface DiskTimingReport {
  profile: DiskTimingProfile;
  mode: "account" | "stall";
  clockHz: number;
  /** Emulated CPU time plus, in account mode, the waits the guest skipped. */
  modelledMs: number;
  /** Time spent, or that would have been spent, waiting on the disk. */
  diskMs: number;
  /** Head loads and motor spin-ups. */
  readyMs: number;
  seekMs: number;
  /** Waiting for sectors to come round. */
  rotationMs: number;
  transferMs: number;
  recordReads: number;
  recordWrites: number;
  /** Record reads served by the deblocking buffer without disk access. */
  bufferHits: number;
  sectorReads: number;
  sectorWrites: number;
  seeks: number;
  readyWaits: number;
  /** Highest cylinder touched. */
  maxCylinder: number;
  /**
   * Cylinders on the real medium. When maxCylinder reaches this, the files
   * would not fit on that floppy and seek times are extrapolated.
   */
  cylinders: number;
}

/** One 2 MB Triptych CP/M disk image. */
export class TriptychDisk {
  /** Wrap an existing image, or create a blank disk with the N04 system. */
  constructor(image?: Uint8Array);
  /** Add or replace files, given as [name, bytes] pairs in CP/M 8.3 form. */
  addFiles(files: Iterable<[string, Uint8Array]>): this;
  addFile(name: string, bytes: Uint8Array): this;
  /** A file's bytes in whole 128-byte records, or undefined if absent. */
  readFile(name: string): Uint8Array | undefined;
  fileNames(): string[];
  freeBytes(): number;
  freeDirectoryEntries(): number;
  /** A copy of the complete 2 MB image. */
  image(): Uint8Array;
}

/** Create a blank disk with the N04 system and the given files. */
export function createDisk(files?: Iterable<[string, Uint8Array]>): TriptychDisk;

export interface MachineOptions {
  /** Slices of 50,000 steps to allow for booting. Default 10,000. */
  maximumSlices?: number;
  /** Model a floppy drive from power-on, so the report includes booting. */
  diskTiming?: DiskTimingOptions;
}

export interface RunOptions {
  /** Slices of 50,000 steps to allow for the command. Default 1,000,000. */
  maximumSlices?: number;
}

/** A booted machine waiting at the A> prompt. */
export class TriptychMachine {
  constructor(images: Uint8Array[], options?: MachineOptions);
  /** Type a command line and return everything printed up to the next prompt. */
  run(command: string, options?: RunOptions): string;
  /** Everything printed since power-on. */
  transcript(): string;
  /** T-states executed since power-on. */
  tstates(): number;
  /** Model a floppy drive, or pass null for instant media. Restarts the counters. */
  setDiskTiming(timing: DiskTimingOptions | null): this;
  /** Disk activity since timing was configured, or undefined for instant media. */
  diskTimingReport(): DiskTimingReport | undefined;
  /** The current contents of a drive, 0 for A:. */
  disk(drive?: number): TriptychDisk;
  /** Release the machine's WebAssembly memory. */
  close(): void;
}

/** Boot a machine with images in drives A:, B: and so on. */
export function bootMachine(images: Uint8Array[], options?: MachineOptions): TriptychMachine;
