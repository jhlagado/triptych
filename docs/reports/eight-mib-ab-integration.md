# A/B eight MiB integration

Date: 2026-09-06. Retained-release host integration and the complete local
Triptych regression gate pass. Hosted A/B browser qualification remains open.

## Release and placement

The A/B system consumes Portable CP/M 0.1.3, revision
`c2b64f013f0a96d015f7aaa7a2c35183579a9559`, from its separately named
`triptych-cpu-v0.1-8m-ab` ZIP. Main Linux CI run 34036247020 passed 361 tests.
The downloaded release matches the retained CI output and fresh local ATOM
builds byte for byte. The separate resident lock and provenance files identify
the manifest and source hashes. Default 0.1.2 inputs remain unchanged.

| Artifact                    | SHA-256                                                            |
| --------------------------- | ------------------------------------------------------------------ |
| CCP at E300                 | `767891db9e1322b5dd5c3e73a2ab87c85756456f74517762ff018e0b6dbd2a63` |
| BDOS at EB00                | `817b0e03552db6a2b369471402524e6c1bebf54163f0d95b75b911c06642fce5` |
| BIOS at F900                | `316f56f30c19416f6229fd760bacc8cad3baab65c6b15f8e856b175ce4c44907` |
| Bootstrap                   | `6ca90515ea8d0824291a26dce3d57a8854cdada6eec8e6aa29d35f3ea0c3c587` |
| Complete 16 KiB system area | `ef8a190fcd28c10b66d46b7292a2bc41ee811ee90c72bcce63601337e33463a4` |

The [disk contract](../specifications/cpm-disk-profiles-v1.md) specifies the
memory and loader lifetimes. The BIOS has 737 live bytes, ending at FBE1
exclusive, with 31 bytes before A's allocation vector. BDOS has its independent
64-byte stack. Neither component uses another component's live workspace.

## Application execution

`node tools/prove-large-ab.mjs --allow-dirty` rebuilds and verifies the retained
OS source, assembles the BIOS/bootstrap and migrates a private fresh distribution.
It does not read or replace a user's saved disk. The two resulting images have
independent identity files and the unchanged pinned ATOM, NUC and Edit releases.

The run passed 30 checkpoints across an editing session and a fresh reopen,
with exact native/WASM console bytes, ANSI terminal state and complete A/B
image comparisons at each boundary. A's entire image stayed unchanged while
editing, compiling and running on B. Saved system records and tool hashes also
remained unchanged. Both host checkpoints matched their complete backing images.

Twelve COM lifetimes were observed at instruction boundaries in WASM. The
57,856-byte load limit passed; the first oversized record was rejected before
entry. Tool wrappers entered at 0100 with SP EAEB, used their E400 stacks and
returned to 0000 with SP EAED. Their stack writes changed dead CCP bytes while
preserving the saved launch word and live BDOS/BIOS. Full CCP and BDOS bytes
were restored before PC reached E300. Maximum observed BDOS stack use was
16 of 64 bytes. Native comparisons establish external behavior and saved bytes;
instruction-level RAM and stack measurements come from WASM.

## Loader and storage faults

The TypeScript BIOS suite has 21 cases covering exact capacity, independent
selection, coordinates, optional B, warm reload and error halts. Its flush-order
assertions do not model per-drive checkpoint snapshots.

The five Rust integration tests instead execute the actual ATOM-built bootstrap
and BIOS with a synthetic setup program in the CCP area. That program leaves
A's provider backing dirty and B's controller cache dirty. A faulting provider
maintains separate backing and checkpoint images. The tests compare complete
images and exact I/O events after success, cache-write failure, A flush failure,
B flush failure and resident-read failures at the first and second backing
sectors. An earlier successful A checkpoint remains when B's flush fails.
No resident reload occurs after a flush failure. A retained dirty-cache payload
survives machine reset and later cache eviction.

The fixture freshness command is
`node tools/build-large-ab-boot-fixture.mjs --check`. Rust also checks source
and fixture-byte hashes. These tests qualify machine, controller and provider
behavior; the synthetic CCP is not an OS or application proof.

## Verification

The final local `npm run check` passed 378 Vitest cases in 25 files, 59 real
browser tests, native/WASM workflow proofs, fixture freshness checks and Rust
formatting, Clippy, workspace tests and release WASM build. Independent reviewers
checked BIOS behavior, release/profile integration, complete-volume allocation
and saved-image preservation.

Native persistent reopening now preserves every saved system byte and requires
explicit profile selection for large images. A separate fresh-creation command
publishes a new pinned disk without replacing an existing file or link. Nine
additional regressions distinguish direct, hard-link and symbolic-link aliases
in disposable preparation. The existing native image-tool proof also passes
with its historical ATOM inputs; commands are sent after the initial prompt
rather than supplied as typeahead during boot and directory login.

Portable CP/M's supplemental full-volume proof passed its 362-test local gate
and Linux CI, then was merged at `7b908dc1bce157d1b354693cc6340c3d39a6e062`.
It writes all 65,280 data records on each of two initially empty filesystems,
then checks disk-full rejection and reconstruction from saved directories.
It changes no released OS bytes. Machine faults, full-volume BDOS behavior and
tool workflows have separate tests rather than one test standing in for all
three boundaries.

## Remaining acceptance

Maximum admitted tool buffers, capacity failures and generated-program failure
and trap lifetimes still need qualification. The browser still requires an A/B
drive-set UI, coherent persistence, whole-set backup and recovery, legacy-state
handling and hosted acceptance. The interactive native launcher still needs an
explicit optional-B attachment path; its current A/B execution proof invokes
the host with both image arguments directly. These remain part of the active
goal. No physical ESP32 storage measurement is claimed.
