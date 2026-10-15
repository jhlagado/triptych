# Triptych headless

A Triptych CP/M 2.2 machine you can drive from Node, with no browser and no
Rust toolchain. Make a 2 MB disk, boot it, type commands and read the files
back. It is built for tests, such as checking that a CP/M program still
builds and runs on the machine people use.

```js
import { bootMachine, createDisk } from "@jhlagado/triptych-headless";

const disk = createDisk([["HELLO.COM", helloBytes]]);
const machine = bootMachine([disk.image()]);
console.log(machine.run("HELLO"));
const after = machine.disk(0);
machine.close();
```

## Disks

`createDisk(files)` returns a blank 2 MB disk with the N04 resident system,
then adds `[name, bytes]` pairs in CP/M 8.3 form. The format has 2,048-byte
blocks and 1,024 directory entries.

A `TriptychDisk` can add files (`addFile`, `addFiles`), read them back
(`readFile`), list them (`fileNames`) and report its free space
(`freeBytes`, `freeDirectoryEntries`). `readFile` returns whole 128-byte
records, as CP/M stores them. `image()` returns the complete disk.

## Machines

`bootMachine(images)` puts images in drives A:, B: and so on, switches on and
waits for the `A>` prompt.

- `run(command)` types a command line and returns everything printed up to
  the next prompt.
- `disk(drive)` returns a drive's current contents. Drive 0 is A:.
- `tstates()` counts the T-states run since power-on.
- `close()` frees the machine's WebAssembly memory.

## Floppy timing

The emulated disk is instant. To see how long the same disk activity would
take on a mechanical floppy drive, give `bootMachine` a timing profile:

```js
const machine = bootMachine([disk.image()], {
  diskTiming: { profile: "8in-sssd" },
});
machine.setDiskTiming({ profile: "8in-sssd" }); // restart the counters
machine.run("ATOM MAIN");
const { diskMs, seeks, modelledMs } = machine.diskTimingReport();
```

The profiles are `8in-sssd` (CP/M's original 8-inch format), `5in-dsdd` and
`3in-dsdd`, listed in `DISK_TIMING_PROFILES`. The default `account` mode
leaves the guest's behaviour and speed unchanged and only adds up the delays.
`mode: "stall"` makes the guest wait for each delay in emulated time, which
costs real time to emulate. `diskTimingReport()` breaks the disk time into
head loads, seeks, rotation and transfer, and counts record and sector I/O.
The model is described in Triptych's
[floppy timing specification](https://github.com/jhlagado/triptych/blob/main/docs/specifications/disk-timing-v1.md).

## Building

From this directory in a Triptych checkout:

```sh
npm run build
npm test
```

The build compiles `crates/triptych-host-wasm` for Node, then copies the N04
boot ROM and system area from `distribution/disk-library`. Both are named by
their SHA-256, and `dist/manifest.json` records the source revision and every
file's checksum. Publishing checks the manifest and refuses a build made from
a dirty working tree.

Triptych is licensed under the GNU GPL version 3 or later.
