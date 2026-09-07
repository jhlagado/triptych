# Triptych CP/M command-line utility

This host-only package provides the `triptych-cpm` executable. It uses the
portable [`triptych-cpm-image`](../triptych-cpm-image/) library and has no
emulator dependency. See that library's README for commands and disk formats.

Build with `cargo build -p triptych-cpm-cli` or run, for example,
`cargo run -p triptych-cpm-cli -- list working.img`. The CLI requires Rust 1.89;
the portable library and its WASM consumers retain their own Rust requirements.
