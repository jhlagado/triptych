# Triptych CPU Alpha proof report

Status: passed host and compile-only milestone

Date: 2026-08-31

## Outcome

Triptych now has one production Rust CPU machine and one native macOS/Linux
host. The core reproduces every language-neutral CPU fixture exactly, including
the complete canonical transcript digest. The native executable cold-boots
CP/M 2.2, runs `SMOKE.COM`, persists `RESULT.TXT`, starts a fresh process, and
reads the file through CP/M after a second cold boot.

The same `triptych-cpu-core` crate compiles for native Rust,
`wasm32-unknown-unknown`, `x86_64-unknown-linux-gnu`, and
`xtensa-esp32s3-none-elf`. The Xtensa result is compile-only. No ESP32 board,
PSRAM, SD card, USB, FreeRTOS, elapsed-time, or electrical claim was measured.

## Production boundary

`triptych-cpu-core` is `no_std`. It owns the private Z80 adapter, overlay,
serial lookahead, port router, logical-record controller, 512-byte cache, and
128-byte write staging. A caller lends RAM, ROM, console, sectors, optional
VDP/sound transports, and an optional full-port observer for a bounded run
slice. No platform reference or third-party CPU type escapes the crate.

The complete architecture choice and rejected lifetime shapes are recorded in
[the CPU core architecture note](../plans/cpu-core-architecture.md).

## Deterministic results

The Rust conformance runner consumed the six checked JSON fixtures without
fixture-specific machine branches:

| Fixture                      | Result |
| ---------------------------- | ------ |
| `boot-overlay-serial`        | exact  |
| `cold-boot-disk-persistence` | exact  |
| `flags-conditional-timing`   | exact  |
| `interrupt-im1`              | exact  |
| `reset-defined-state`        | exact  |
| `serial-read-order`          | exact  |

“Exact” means the complete result object and canonical SHA-256 digest match the
TypeScript oracle, including register and flag values, steps, T-states,
underlying RAM hash, retained RAM bytes, persistent-drive hash, serial output,
and ordered full 16-bit I/O transcript. The cold-boot fixture completed 817
instructions and 8,220 T-states.

Focused Rust tests additionally proved all four record quarters, preservation
of neighbouring records, private partial-write staging, dirty-cache retention
across reset, explicit flush, bounds rejection, write protection, and provider
failure mapping.

## Native operating-system proof

The proof used an external, provenance-reviewed 256,256-byte CP/M 2.2 image
with SHA-256
`b5c95ef5b1d4c9ef746aa3933f5187055cdaa8f048c5c78ccafc485b326dad5e`.
The image was not copied into Triptych. The development tool assembled
Triptych's own `roms/cpu/bootstrap.asm` and `roms/cpu/bios.asm`, installed the
BIOS in a temporary copy, and invoked only the production Rust executable for
guest execution.

Process one produced the expected cold-boot prompt, ran `SMOKE.COM`, and
reported that it wrote `RESULT.TXT`. Process two reopened the resulting disk,
cold-booted again, ran `TYPE RESULT.TXT`, and printed:

```text
CP/M file services are working
```

The separate native integration test also performs a smaller two-process
write/flush/read proof directly against the file-backed sector host.

## Toolchains and target evidence

| Surface      | Evidence                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| Native macOS | Rust 1.98.0 tests, Clippy with warnings denied, CP/M two-process proof                                        |
| Linux API    | `cargo check --workspace --all-features --target x86_64-unknown-linux-gnu`                                    |
| WebAssembly  | release build for `wasm32-unknown-unknown`; 16 KiB linked `no_std` execution probe returned four T-states     |
| ESP32-S3     | `espup` 0.17.1; Espressif Rust 1.97.0-nightly (`8ea53bcd7`); release core build for `xtensa-esp32s3-none-elf` |

The Xtensa build used `-Z build-std=core,alloc`. `cell80-z80` 0.8.0 is still
pinned exactly and has no Cargo dependencies, but it unconditionally imports
`alloc` for its unused disassembler. A standalone `no_std` WASM probe therefore
supplies a rejecting allocator whose every operation traps, executes a real Z80
HALT through the public core, and returns four T-states successfully. This
proves no hidden runtime allocation on the exercised execution path while
retaining the upstream crate unmodified. Upstream should eventually make the
disassembler an optional feature so a final link needs no allocator symbol at
all.

## Commands retained

```sh
cargo test --workspace --all-features
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo build -p triptych-cpu-core --lib --target wasm32-unknown-unknown --release
cargo check --workspace --all-features --target x86_64-unknown-linux-gnu
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img npm run proof:cpm22-native
```

The isolated Xtensa command was:

```sh
cargo +triptych-esp build -Z build-std=core,alloc \
  --target xtensa-esp32s3-none-elf \
  -p triptych-cpu-core --lib --release
```

## Remaining work and claims not made

- The headless JavaScript/WASM adapter and browser transcript run remain Stage
  5; the core and allocation-trap execution probe already link and execute.
- The ESP-IDF host project, flashable image, Linux ESP-IDF link reproduction,
  and section report remain Stage 6.
- No physical board result exists until the ordered Waveshare units arrive.
- The native terminal currently uses ordinary standard input and output. A
  later monitor may add raw terminal mode and out-of-band debugger controls.
- Only the selected engine's `$FF` maskable interrupt acknowledgement is
  exposed. NMI and arbitrary IM0/IM2 data are not claimed.
- CP/Mish remains a later, separately provenance-recorded port. This proof is
  the retained CP/M 2.2 compatibility milestone.
