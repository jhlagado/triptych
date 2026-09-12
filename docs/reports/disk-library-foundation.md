# Disk-library foundation

Date: 12 September 2026

The Rust development setup is qualified on this Mac. The disk-library
implementation has a tested live-media boundary, but no published disk-box UI
or launch-recipe service yet. The
[implementation contract](../specifications/disk-library-v1.md) records the
remaining storage, launch and recovery requirements.

## Development baseline

Rustup launchers and the shell environment were restored. The project uses its
pinned Rust 1.98.0 toolchain, with formatting, Clippy, Rust source and language
server components available. The WASM target and matching wasm-bindgen 0.2.127
command are installed. The user's separate default toolchain was preserved.

The complete `npm run check` passed in the original Triptych checkout at
`8a186e69f83a9c0cf324c6ef4f1bc29441f1d4ab`, with the local roadmap/favicon work
present. That run includes native and WASM tests, browser workflows, the
31-job two-MiB tool-lifetime matrix and the final Rust checks. It qualifies the
development baseline, not the later disk-library changes.

## Public-release reconciliation

The isolated `disk-library` branch combines the configurable-drive development
with the published A/B games setup. Commit `7a572e4` records that merge. Fresh
machines still receive the existing system/tools and games pair during this
integration stage. Saved machines and the separate supplied-machine namespace
remain distinct.

The 150 browser-module checks and three public-startup browser tests passed.
Those tests include both games saving and reloading, independent supplied
machine saves, and a missing B image preventing partial publication. The
deployment checker accepted all 80 built assets, including the sixteen
two-MiB profile descriptors and the prepared favicon assets. These are local
build results, not a new GitHub Pages deployment.

The full browser run exposed three old empty-B assumptions in the configurable
drive tests. The revised tests preserve and compare the supplied game files,
and explicitly eject B before staging a blank replacement. All six tests in
that activation suite then passed, including sixteen-drive persistence and
historical recovery. The complete suite still needs a clean integrated rerun.

## Cooperative swap proof

`npm run check:live-media` builds the WASM host and runs the prepared-ticket
tests plus an ATOM guest fixture on the real four-drive CP/M profile. The
fixture is 587 bytes at `$0100`.

The program reads and closes a file on B, flushes B, then waits for disk two.
The host changes B while preserving all guest RAM and reported CPU registers.
After BDOS function 37 resets B, the program reads the new sentinel, creates
`NEW.TXT`, closes and flushes it, and returns to CCP. `KEEP.BIN` on the incoming
disk remains exact. Direct controller writes to protected A fail, and its
complete checkpoint remains unchanged.

The normal proof passed after 392,000 scheduled instructions. A negative
control replaces the fixture's eight-byte BDOS-reset setup/call sequence with
NOPs in memory; it must reach `LIVE FAIL` and halt after passing the same
pre-swap checks. Independent review reproduced both outcomes. This establishes
that the reset is required by this workload, without attributing failure to a
particular internal allocation or login operation.

Controller tests separately reject partial transfers and dirty caches without
losing their state. WASM ticket tests cover frozen mutation paths, wrong and
stale tickets, cancellation, incoming-byte ownership and allocation-free
commit. Guest filesystem cooperation remains a caller requirement.

Protected media now allocates only its backing bytes; checkpoint and dirty
tracking vectors retain zero capacity. Both initial installation and prepared
replacement use that representation. Actual WASM tests verify independent
checkpoint exports and guest write rejection for both paths. The complete
Rust formatting, Clippy, workspace tests and WASM release-build check passed
after these changes.

## Remaining qualification

The full integrated check and CI must pass before release. Persistent disk-box
records, immutable catalogue references, launch-instance reuse, crash ordering
across database publication, incompatible-A recovery and actual public-site
acceptance remain implementation work. The live fixture does not establish
those behaviors, native hot-swap parity or ESP32 hardware performance.
