# WASM working-disk persistence checkpoint

2026-09-05. This is an early S5 checkpoint against the current transitional
Triptych disk, not the revision-pinned S4 distribution.

## Durability boundary

The WASM sector store now counts successful guest flush commands per drive.
The browser compares that count after each bounded execution slice. A new count
causes one complete drive export; unchanged slices do not copy the disk. The
browser then writes the snapshot to IndexedDB and reports the transaction state
separately from the machine status.

The browser storage layer belongs to the page rather than the portable Rust
machine. The Rust core still defines the disk-controller flush. The WASM host
exposes the count and copied image, while the page selects storage policy.

Replacement snapshots and flush snapshots share one serial queue. If several
changes arrive during an active transaction, the queue retains the newest
pending snapshot. A failed transaction reports an error without preventing a
later flush from retrying. Replacing a machine resets the observed flush count.

The page retains access to `Download working disk` after a WASM fault when a
machine and drive still exist. This provides a recovery path for the last
flushed in-memory data even when execution has stopped.

## Automated checks

The focused browser-storage suite passes nine tests. It checks stored-record
validation and byte copying, reload state, flush-edge detection, lazy disk
export, write coalescing, transaction failure reporting and recovery on a later
flush. The component-lock work added in parallel has a separate 14-test suite.

The Rust WASM-host suite passes two tests, including independent flush counts
for two drives and failure for an absent drive. The browser ANSI/source check
passes, and the generated WebAssembly declaration contains
`drive_flush_count(drive: number): number`. The browser build includes both new
storage modules.

The complete guarded `npm run check` also passes with AZM imports blocked. Its
Vitest stage passes 175 tests across 14 files, including the storage and
component-lock suites. Formatting, lint, CP/M readiness and matrix checks,
headless scenario validation, browser UI checks, Rust formatting and Clippy,
all Rust workspace tests, and the release WASM build pass in the same run. Its
log is `/tmp/triptych-working-disk-check.log`.

Commands:

```sh
npx vitest run test/wasm/working-disk-persistence.test.mjs
cargo test -p triptych-host-wasm
npm run check:wasm-browser-ui
npm run build:wasm-browser
```

The Cargo commands used the repository's pinned Rust toolchain. The browser
build used `wasm-bindgen` 0.2.127.

## Live browser proof

The generated page was served at `http://127.0.0.1:8091/` and opened in the
Codex in-app browser. It booted to `A>` and reported completion of the initial
IndexedDB save. Reload then reported that it had restored the browser working
disk.

At the CP/M prompt, `SAVE 1 PERSIST.COM` created a one-record file. `DIR`
listed `PERSIST COM`. After another page reload, the page again reported a
restored working disk and `DIR` still listed the same file. This proves one
guest flush, browser transaction, reload and reopen path against the local
generated bundle.

## Remaining S5 work

This checkpoint does not complete S5. The committed browser tests do not yet
drive a real browser, and the live sequence did not exercise Edit, ATOM or NUC.
Denied and quota-exhausted storage use a simulated failing adapter rather than
a browser fault. The download/reimport path, session-replacement recovery,
interrupted transactions, machine-fault recovery, bounded input/output backlog
and narrow-viewport interaction tests remain. No physical Android or iOS result
is claimed.
