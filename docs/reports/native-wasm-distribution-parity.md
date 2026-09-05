# Native and WASM distribution parity

2026-09-05. The macOS parity proof uses one freshly built, component-pinned
distribution for both actual Rust hosts. It runs ATOM on `HELLO.ASM`, executes
the result, edits `INPUT.NU`, saves it, compiles with NUC and executes the
modified program. A second session reopens the saved source and runs the saved
executable. Native starts a new process; WASM starts a new machine instance.

The proof compares exact console bytes and canonical terminal snapshots at
15 checkpoints. It also compares the whole disk and exported `HELLO.COM`,
`INPUT.NU` and `INPUT.COM` after each session. Explicit output assertions require
successful ATOM compilation, the hello message and the modified NUC output.
The shared terminal decoder proves interpretation of the equal byte streams;
it is not an independent native terminal-rendering measurement.

The focused macOS run passed, with final disk SHA-256
`d148fbbe2f6b57258bb99c7390b086de5a69bbd7d9071ddc0993297b7c31c37c`.
The development run explicitly allowed a dirty source tree and reported that
state in its distribution manifest. The proof uses private temporary disks and
does not modify saved user disks.

`npm run proof:cpm-host-parity` builds both hosts and requires a clean source
tree. `npm run check:cpm-host-parity` explicitly allows development changes.
The latter is included in `npm run check`, alongside the separate native PTY
setup/restoration checks. Linux CI results remain required; no ESP32 or physical
mobile results are claimed by this checkpoint.
