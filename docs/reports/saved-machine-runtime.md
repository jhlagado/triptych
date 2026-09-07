# Saved-machine runtime preparation

Date: 2026-09-07. Scope: isolated runtime adapter; application activation and
deployment wiring remain separate integration work.

`saved-machine-runtime.js` connects the saved representations to the existing
WASM CPU API. `prepareSavedMachineRuntime` accepts a snapshot, `TriptychCpu`,
optional deployment metadata and crypto implementation, and a boolean
`writable` flag that defaults to false. It returns a reset CPU without executing
guest instructions. The [admission design](two-mib-system-admission-design.md)
and [v4 contract](../specifications/cpm-drive-set-v4.md) govern saved inputs.

Two-MiB input passes through no-fetch saved admission before CPU construction.
Unavailable profiles and bootstrap mismatches reject preparation with their
existing admission codes. Historical input uses the unchanged v3 copy boundary;
the returned checkpoint retains the unwrapped `bootstrap`/`drives` shape.
The eight-MiB A/B profile still has two configured slots when B is absent.

## Ownership and checkpoints

The returned handle contains `cpu`, `media`, `captureCheckpoint()`,
`flushCounts()` and `dispose()`. `media` is deeply frozen metadata: resident
profile, configured count and nullable slots containing names and, for v4,
stable instance IDs. There are no disk byte arrays in that metadata.

The CPU receives each present image at its original slot index. Preparation
retains only metadata, expected image lengths and a private bootstrap after
installation. Returned closures are constructed in a separate scope without
the captured input snapshot. The actual WASM CPU stores its own live and
checkpoint arrays; this adapter does not retain another full disk copy.

`captureCheckpoint()` exports only `export_drive_checkpoint` bytes. Those are
owned copies of the initial image or last successful guest flush, rather than
unacknowledged live backing sectors. Each call returns a new bootstrap copy and
the original saved shape. `flushCounts()` uses configured indices and returns
zero for absent media. Neither operation publishes browser storage.

The caller controls activation, input and execution scheduling. It must stop
execution while collecting a checkpoint and use `dispose()`, rather than
calling `cpu.free()` directly. Disposal is idempotent; later CPU access,
checkpoint capture and flush-count reads reject. Partial installation or reset
failure releases a constructed CPU once. If cleanup also throws, both failures
are retained in an `AggregateError`.

## Executed qualification

On macOS, the focused deterministic suite passed **36 tests**:

```sh
node --test --test-concurrency=2 test/wasm/saved-machine-runtime.node.mjs
```

Cases cover all sixteen counts, all sixteen inserted media, sparse A/P,
historical layouts, acknowledged-versus-live bytes, immutable metadata, stable
identities, read-only/default and explicit writable installation, input mutation
across admission, unavailable profiles, malformed input, partial failures and
idempotent disposal. The CPU double fails immediately if preparation calls
`step`, `run_slice` or live `export_drive`.

The actual-WASM suite passed **2 tests**, using an isolated existing binding
and captured n01/n16 artifacts:

```sh
TRIPTYCH_WASM_MODULE=/tmp/triptych-wasm-two-mib.CRz7fw/bindings/triptych_host_wasm.js \
TRIPTYCH_TWO_MIB_FIXTURES=/tmp/triptych-two-mib-browser-fixtures.371Bnr \
node --test --test-concurrency=2 test/wasm/saved-machine-runtime-wasm.node.mjs
```

Both machines had PC zero, zero executed steps and unchanged acknowledged
images immediately after preparation. They then booted to the A prompt. The
n16 machine selected P and warm-booted back to P; A/P flush counts advanced,
absent B–O counts remained zero, and complete checkpoints remained unchanged.
Mutating the caller's original images and bootstrap after preparation did not
change the installed machine. The first test run used the wrong JavaScript
access form for the CPU-state `pc()` method; correcting that test call produced
the passing result. No production change was needed for it.

These tests do not establish storage publication, app-level activation,
full ATOM/NUC/Edit tool lifetimes, browser peak memory, Linux behavior or ESP32
measurements. The two actual-WASM tests require explicit fixture paths and fail
when they are missing. The parent integration must add both suites to its
appropriate verification gates and run the full repository checks.
