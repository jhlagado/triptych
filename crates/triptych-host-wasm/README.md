# Triptych headless WASM host

This crate exposes the portable Triptych CPU machine to JavaScript through a
small `wasm-bindgen` class. It has no DOM, browser-storage, timer, worker, or UI
dependency.

`TriptychCpu` owns copied buffers for:

- 64 KiB guest RAM and the 256-byte boot ROM;
- queued serial input and captured serial output;
- complete in-memory disk images;
- the ordered full-port I/O trace.

The portable core still owns every guest-visible CPU and controller rule. No
JavaScript object or callback is retained by the core while an instruction is
executing.

## Lifecycle

Construct a machine with the boot ROM, install complete 512-byte-aligned drive
images, optionally initialize RAM, then call `reset`. Drive media cannot be
replaced after execution begins because the core may own a dirty cache line;
construct a fresh machine to model new media or a fresh process.

Use `step` when an instruction-boundary `$FF` maskable interrupt must be
scheduled. Use `run_slice` for ordinary bounded execution. Its result codes
are zero for HALT, one for the step limit, and two for the T-state limit.

RAM, serial output, drive images, CPU snapshots, and packed I/O operations are
returned as copies. A packed I/O word uses bits 0–7 for the byte, bits 8–23 for
the complete Z80 port, and bit 24 for write versus read.

The non-default `conformance` feature adds only a pre-reset architectural-state
patcher used by the language-neutral fixture runner. Normal builds do not
expose arbitrary CPU-state mutation.

## Build

The Rust crate pins `wasm-bindgen` 0.2.127. The matching command-line tool must
generate the JavaScript bindings:

```sh
cargo install wasm-bindgen-cli --version 0.2.127 --locked
npm run build:wasm-host
```

Generated bindings are placed in `dist/wasm/` and are not source-controlled.

The same adapter runs declarative CCP and `.COM` sessions without a browser:

```sh
npm run proof:cpm-headless
```

The scenario runner compares exact serial output before applying the shared
ANSI terminal model, and carries only the exported disk image into the next
fresh-machine session. It runs every fixture under `test/bdos/scenarios/` by
default; `TRIPTYCH_CPM_SCENARIO` selects one fixture.

## Browser terminal

The static page in `web/` uses the same `TriptychCpu` class. It accepts a CP/M
disk through the page or the local development server, installs the generated
Triptych BDOS and BIOS in a browser-memory copy, and executes bounded CPU slices
between browser frames. Its host-owned 80-by-24 screen consumes the bounded
Triptych ANSI profile, renders per-cell bold, underline, and reverse attributes,
and shows the emulated cursor. Keyboard events supply raw serial bytes,
including ANSI arrow-key sequences; reset uses the machine's existing reset
contract. The parser is UI code and does not enter the WASM adapter or portable
CPU core.

The exact matching `wasm-bindgen` executable builds the browser bindings and
page:

```sh
npm run build:wasm-browser
```

For a complete local session using the bundled CP/M 2.2 disk with the current
Triptych BDOS and BIOS installed at boot:

```sh
npm run run:wasm-browser
```

The server listens only on `127.0.0.1`. `TRIPTYCH_CPM22_IMAGE` can override the
bundled disk, and the page retains a file picker for selecting another image.
The current Triptych resident components are installed into either source
image in browser memory; the supplied image is never modified. `Download
working disk` exports the in-memory image, including only guest writes flushed
through the disk controller.
