# Drive-set storage and native B

Checkpoint: 2026-09-07, commit `5750a2c`. The native A/B launcher, supplemental tool-limit proof and
browser storage components pass local verification. The browser page still uses
its previous single-drive coordinator; the new storage code is not activated or
deployed. The [implementation plan](../plans/browser-drive-sets.md) defines the
remaining integration and recovery gates.

The subsequent [browser integration report](eight-mib-browser-ab.md) records
activation of this storage interface and its current acceptance evidence.

## Native saved drives

`TRIPTYCH_CPM22_WORK_DISK_B` attaches a second saved image when A is supplied
through `TRIPTYCH_CPM22_WORK_DISK` and the explicitly selected bootstrap profile
is `triptych-cpu-v0.1-8m-ab`. Preparation preserves both complete images. It
rejects mismatched capacities and same-file aliases, including symbolic and hard
links, before writing its private bootstrap. These are launch-time checks, not
file locks against concurrent external replacement.

The native distribution suite passes 37 tests. The real terminal proof,
`python3 tools/prove-native-terminal.py --large-ab`, creates two private verified
images, reads explicit A/B filenames, saves an Edit file on B and returns to the
B prompt through warm boot. A's complete image and both saved system areas stay
unchanged. A fresh process reopens the saved B file without changing either image.
Existing terminal Ctrl-C and SIGTERM restoration checks also pass.

## Tool limits under the A/B resident layout

`node tools/prove-large-ab-limits.mjs --allow-dirty` exercises retained ATOM,
NUC and Edit releases on private eight MiB images. The run passes 19 checkpoints
and 14 observed COM lifetimes, with exact native/WASM transcripts and both
complete image comparisons at every boundary. Every initial B file remains
unchanged, including tool binaries, unrelated files and generated test inputs.
Successful compilation adds new files; rejected compilation preserves the prior
output and leaves no compiler temporary or backup file behind.

| Boundary              | Accepted     | Rejected                                  |
| --------------------- | ------------ | ----------------------------------------- |
| ATOM generated output | 18,304 bytes | 18,305 bytes                              |
| ATOM source           | 65,535 bytes | 65,536 bytes                              |
| NUC source            | 65,535 bytes | 65,536 bytes                              |
| Edit text buffer      | 47,104 bytes | Further insertion and a 47,105-byte input |

Generated NUC unhandled failure and dynamic array-bounds trap programs return
through address zero with the expected diagnostic. The preserved successful
NUC output prints a separate `K` line. The observer checks the saved return
word, actual return SP, full resident reload before CCP entry, allocation guards
and immutable BDOS/BIOS ranges. Observed downward use from the tools' E400 stack
tops is 26 bytes for ATOM, 80 for NUC and 18 for Edit; maximum BDOS use is
14 of 64 bytes. Those are WASM instruction-level observations. Native evidence
is external console and disk parity.

This proof does not exhaust compiler symbol, pending or dependency tables,
NUC generated-image and writable arenas, recursive activation capacities or
Edit query/replacement limits. These exclusions must remain distinct from the
tested source, output and text-buffer boundaries.

## Browser codec and persistence

The codec preserves a complete bootstrap/A/optional-B value, hashes each image
and supports a standalone complete-set archive. Nine Node tests cover round
trips, distinct and identical eight MiB images, byte-copy isolation, explicit
profile identity, malformed lengths, corrupt payloads and canonical metadata.

The new IndexedDB store adds one version-three head, metadata-only operation
receipts, complete-set backups and shared immutable image payloads. Existing
version-one and version-two records remain untouched. Twenty-two Chromium tests
cover whole-set concurrency, stale and repeated operations, missing receipts,
shared-image cleanup, malformed and missing backup roots, blocked upgrades,
upgrade failure and raw recovery. Eight injected abort/quota cases fail after
image, backup, head or cleanup operations; every case preserves the preceding
state and permits a safe retry. Asynchronous duplicate-key failure is covered
separately.

Backup listing validates metadata and labels it `available`; reading a backup
verifies its complete referenced bytes. Cleanup retains every referenced image.
Malformed manifest roots or missing referenced keys suspend cleanup. A malformed
payload at an existing referenced key remains recoverable as raw bytes; this
does not suspend collection of unrelated, unreferenced images. Checking all
historical payload hashes on every autosave is not an implemented guarantee.

## Review and combined verification

Cross-review used workers from the existing parallel tasks plus the primary
review. Reviewers did not implement the components they reviewed; they retained
the task context and were not a fresh-context multi-model panel.

Review exposed a noncanonical UTF-8 BOM accepted by the archive decoder. A
regression first failed with a missing expected rejection, then passed after
the decoder stopped stripping that prefix. Another review found that checking
for `K` could match the echoed `NKEEP` command; the proof now requires the actual
output line. A missing-receipt probe became a retained browser regression.
No blocking finding remains in the reviewed codec, store or limits-proof scope.

The complete local `npm run check` passed 392 Vitest cases, 80 Chromium cases,
nine codec cases within the browser utility checks, native/WASM workflow and
limit proofs, and Rust formatting, Clippy, workspace tests and release WASM
build. After that run's browser phase, the missing-receipt regression was added;
the complete 22-case storage suite then passed separately. The updated NUC output
assertion was included in the full run's later limits proof.

## Next integration

The next unit is the drive-set workspace coordinator and verified A/B deployment
assets. Its autosave must capture both last-successful-flush checkpoints without
requiring all drives to be idle, while manual replacement keeps that readiness
requirement. The application then needs selected-drive controls, explicit
backed-up transitions and complete-set recovery. Queue bounds, browser memory
and latency, same-origin recovery deployment and hosted acceptance remain open.
No ESP32 hardware result follows from these host tests.
