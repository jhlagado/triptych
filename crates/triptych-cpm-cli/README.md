# Triptych CP/M command-line utility

This host-only package provides the `triptych-cpm` executable. It uses the
portable [`triptych-cpm-image`](../triptych-cpm-image/) library and has no
emulator dependency. See that library's README for commands and disk formats.

Build with `cargo build -p triptych-cpm-cli` or run, for example,
`cargo run -p triptych-cpm-cli -- list working.img`. The CLI requires Rust 1.89;
the portable library and its WASM consumers retain their own Rust requirements.

All CLI inputs and existing replacement targets require a nonblocking exclusive
regular-file lock. This includes `list`, source images, system areas, imported
host files and read-only files. A disk mounted by the native host is therefore
unavailable to the CLI until the host closes it. Missing lock support is an
error; there is no unlocked fallback. Keep images offline when using other
editors or utilities that do not acquire these locks.

An import retains its original image lock while preparing the replacement.
Publication holds the new file's lock across the rename, so neither inode has
an unlocked publication window. Source and destination path identities are
checked before publication. `export --force` can replace an existing unlocked
regular file; if the destination was initially absent, it still uses atomic
no-clobber publication. A dangling symlink counts as an existing entry and is
never replaced through the absent-destination path.

Failures before publication preserve the destination. If publication succeeds
but temporary-file cleanup fails, the error explicitly states that the output
was published. The published output is retained. These advisory locks and path
checks assume cooperating processes on macOS/Linux; they do not prevent a
hostile process from changing paths between filesystem calls. The non-regular
file preflight avoids ordinary FIFOs and devices, not adversarial replacement
of a pathname during open. Directory fsync and physical power-loss guarantees
are outside this change.
