# Two-MiB WASM filesystem operations

Date: 2026-09-07. Status: isolated implementation and focused checks passed;
browser controls and persistent publication remain separate work.

`CpmDisk.create_two_mib()` creates an independent empty data disk with a zeroed
reserved area. `migrate_to_two_mib(systemArea)` constructs a private candidate
using the caller's complete 16,384-byte system area. It preserves files across
all sixteen CP/M users and rejects non-fitting input as a complete operation.
Neither method mounts media, installs tools or publishes saved state. System
area length is checked here; resident compatibility is checked at admission.

The existing eight-MiB creation and migration methods retain their behavior.
Both migration entry points use one private geometry-parameterized path to the
image library, including rejection of pending imports before transformation.
The source and pending batch remain unchanged on rejection.

Eleven Rust filesystem tests passed, including the historical cases, independent
two-MiB instance/export ownership, both migration targets and capacity rejection.
Clippy passed for the WASM package and all its test targets with warnings denied.
The release WASM binary was generated in an isolated build directory and bound
with wasm-bindgen 0.2.127 for the Node tests.

Four tests against that actual WASM binary passed. They check the exact geometry,
independent copies and staged byte ownership; user 15, all three attribute bits
and an empty file through migration; non-fitting eight-to-two-MiB rejection; and
bad system lengths or pending batches through both APIs. Complete source images
are compared after success and failure. The user-15 test compares directory
metadata and record bytes because ordinary file access remains user-0-only.

An independent read-only reviewer reran all four WASM tests and traced the
wrapper through the image library's all-user migration, with no findings. The
tests use macOS, Rust 1.98 and Node; they establish neither browser publication
nor bootable residents, live-machine reconfiguration or ESP32 behavior.

```sh
cargo test -p triptych-host-wasm files::tests
cargo clippy -p triptych-host-wasm --all-targets -- -D warnings
npm run build:wasm-host
node --test test/wasm/two-mib-files.node.mjs
```

An isolated generated binding may be selected with `TRIPTYCH_WASM_MODULE`.
Normal verification uses the repository's freshly built Node binding.
