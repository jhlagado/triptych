# Two-MiB design evidence

Date: 2026-09-07. Source baseline: Triptych `63870af197e9a31d666d5b8d2ef49f1804e2f556`;
Portable CP/M `447b20afc9c2c1823e4dc81f1af460c84e27d1d7`.
This records design and preliminary implementation evidence, not a release or
a sixteen-drive production-host result.

## Historical configuration

The pre-project Triptych revision `1589d7e` and initial `83263ae` have the IBM
3740 geometry: 256,256 logical bytes, 1,024-byte blocks, DSM 242, DRM 63 and a
31-byte ALV plus 16-byte checksum vector. BIOS selection admits only A. The
pre-project Rust image library accepts only the logical and 256,512-byte padded
forms. Controller drive-number width did not establish additional CP/M drives.

The published `wasm-0f7f077` CI archive was fetched and independently checked:

```text
archive SHA-256: 27abd8deac81701236ee748459760928d42478df12eb1390332c47929a796b84
actual cpm22.img: 256,512 bytes
manifest logical bytes: 256,256
actual BIOS: 1,024 bytes; matching legacy DPB begins at offset 441
```

No two-MiB profile was found in the inspected Triptych lineage. Two MiB is now
the user's chosen design, not a claim about that earlier release. Current fresh
browser startup still selects the legacy A-only profile. Keeping optional large
profiles does not charge their ALVs to a running legacy configuration.

## Candidate comparison

Two independent read-only proposals used the same rubric: sixteen distinct
drive states, complete RAM/TPA and stack accounting, saved-data preservation,
independent ownership, and a bounded implementation with executable failure
tests. Both selected count-specific resident builds, a 1,024-entry directory,
one shared DPB/buffer, separate DPHs/ALVs, and guarded reboot for configuration
changes. Both rejected always reserving sixteen ALVs, shared allocation maps,
hidden emulator state, runtime binary relocation and a blanket source rollback.

The selected base uses a page-aligned allocation reservation with any odd-count
half-page padding after the configured slots. The other proposal placed that
padding below the ALVs. Origins and TPA are identical; the selected layout gives
one formula for BIOS end and allocation-table start, and preserves existing ALV
addresses within each odd/even pair. Count changes still require a reboot.
An independent cross-review agreed with this choice and required the explicit
BIOS feasibility gate, immutable mounted-media lifecycle for CKS zero, and
separation of COM load limits from tool workspace. Its explicit 32/64-MiB
host-payload accounting is retained. The first proposal's 768-byte common-BIOS
budget and separate 256-byte DPH region make the size gate precise.

A 512-entry directory would save 16 KiB on disk but halve the number of tiny
files before directory exhaustion. The selected 1,024 entries cost no extra
ALV bytes or directory-buffer RAM with CKS zero. Directory-scan latency remains
unmeasured. The disk/block choice was supplied by the user and was not reopened.

## Scratch assembly and proof limits

Existing retained upstream CCP and BDOS source was assembled with the installed
pinned ATOM path at every proposed count's origins. The experiment used external
scratch files; no production assembly source, release artifact or saved disk
changed. All 32 assemblies produced the declared 2,048-byte CCP and 3,584-byte
BDOS. Every assembled BDOS base and saved launch word remained above E400.

| Slots | CCP / BDOS base | Assembled saved launch word | COM load bytes |
| ----- | --------------- | --------------------------- | -------------: |
| 1–2   | E500 / ED00     | ECEB                        |         58,368 |
| 3–4   | E400 / EC00     | EBEB                        |         58,112 |
| 5–6   | E300 / EB00     | EAEB                        |         57,856 |
| 7–8   | E200 / EA00     | E9EB                        |         57,600 |
| 9–10  | E100 / E900     | E8EB                        |         57,344 |
| 11–12 | E000 / E800     | E7EB                        |         57,088 |
| 13–14 | DF00 / E700     | E6EB                        |         56,832 |
| 15–16 | DE00 / E600     | E5EB                        |         56,576 |

These results establish component assembly fit and the current symbol locations,
not execution safety or a new qualified OS release. The scratch generalized
BIOS uses 723 common bytes, leaving 45 of the 768-byte budget. Exactly N
16-byte DPHs occupy the separate table region; the loaded BIOS remains 1,024
bytes. The bootstrap uses 124 live bytes in its 256-byte image. Production
parameterized sources and permanent tests are now present in Triptych.

Scratch tests passed all sixteen counts: distinct selectors, record-boundary
reads/writes, invalid coordinates, cold loading and warm reload. Independent
review found no source/layout defect but identified proof limits. Boot execution
stops at the CCP address with dummy resident data. Uniform record data weakens
some read-address assertions. Injected flush errors on clean images establish
halt-before-reload control flow, not dirty-cache durability. Permanent tests
must strengthen these cases and add failed selection, interior missing slots
and resident-read faults.

The production promotion replaces scratch rewriting with explicit EQU parameters
and generated DPH entries. Its 93 tests pass; a combined run with the legacy
one-drive/A/B BIOS suites passes 133 tests. The main coordinator independently
assembled all sixteen new profiles and inspected the complete sources and tests.
Independent review found no blocker. The permanent tests strengthen exact read
addresses, record-distinct data, complete cold-load comparison, poisoned warm
resident replacement, rejected bindings and dirty-cache control flow. They still
stop before executing CCP and do not qualify Rust or browser durability.
Cold-bootstrap read faults, missing A and sparse interior media remain named
integration tests to add.

The existing BDOS source uses word-sized directory counters and both directory
allocation-mask bytes. That supports investigating DRM 1,023 and AL0/AL1 FF/FF;
it does not replace full-directory execution. Existing independent-ALV logic
preserves reservations in open, unclosed FCBs; a shared or lazily reconstructed
ALV would need a different contract and is not selected.

## Current gaps

Six new Portable CP/M interface tests passed with independent review and rerun.
They cover sixteen live open-file reservations, login/read-only/reset masks,
word-block boundaries, final-record rejection, and 1,024 guest MAKE/CLOSE calls
followed by directory exhaustion and last-slot reuse. The full upstream check
passed 369 tests in 20 files. These tests use a BIOS double at the existing
EC00 BDOS origin; injected full allocation maps are not full-volume write proofs.

Portable CP/M now includes the sixteen named resident profiles. Its subsequent
full check passes 402 tests in 21 files, including deterministic release builds,
exact COM load ceilings, incoming return words and oversized-file rejection at
every placement. Independent review found no material implementation defect.
The RET-only program proves warm-boot return and command re-entry, not recovery
of damaged residents; exact resident restoration is tested by the Triptych BIOS
suite. No upstream release has been published or pinned into Triptych yet.

The Rust image library and native format/migration commands now explicitly
support `triptych-cpm-2m-v1`. The focused crate suite passed 37 tests: 20 unit,
five CLI, seven existing large-disk tests and five new two-MiB tests. The CLI
and all-user migration cases now exercise both large geometries. New cases fill
the data area through block 1,015, check word references 255/256, install 1,000
small files, validate 1,024 empty entries and reuse slot 1,023. Non-fitting
migrations leave source bytes unchanged; two-to-eight-to-two-MiB file round trips
pass. An oversized CLI migration also leaves both inputs unchanged and creates
neither a destination nor a partial file. Independent review found no material
defect in the initial 36-test patch; the extra CLI case was added afterward.

The Rust workspace tests and Clippy with warnings denied also pass. One optional
checkpoint performance measurement remains explicitly ignored by the normal
test run; no timing conclusion is drawn from it.

The empty-directory Rust fixture constructs on-disk entries because host import
rejects empty input; the upstream test creates those entries through guest calls.
WASM file operations inherit two-MiB recognition from the library, but this
does not qualify browser mounting, resident selection or saved-state publication.

The Rust providers already use indexed drive collections, but native launchers,
browser UI, v3 saved-state validation and resident profiles currently qualify
legacy A and optional eight-MiB A/B, not the new family. All sixteen-slot
configuration, guest execution, persistence and tool gates remain ahead.

## Initial production-host probe

A disposable development probe boots the current Rust native and WASM hosts
with the new BIOS/bootstrap and explicit locally built Portable CP/M artifacts.
Counts 1, 2, 4 and 16 pass. Each session selects the highest configured drive,
assembles TWOTEST.ASM with ATOM, runs TWOTEST.COM and reads a completion file.
Complete terminal transcripts and every final disk byte match between hosts;
all other drives remain byte-identical to their initial images. WASM exports
use acknowledged checkpoints. Native sessions flush before the final prompt.

The probe is outside the repository at
`/tmp/triptych-two-mib-host-smoke.Te931B/smoke.mjs`; its successful results are
in `paced-tu5HUZ/results.json` below that directory. Native input is paced at
each prompt. An initial all-at-once input attempt lost commands during CP/M
input draining and was corrected in the harness. The successful probe uses
dense attachments and a simple ATOM program; it does not qualify sparse media,
Nucleus/Edit arenas, fresh-process reopening, browser publication or released
component provenance. It has no production fallback to a sibling checkout.

The complete Triptych `npm run check` passed after the BIOS/image slices:
552 Vitest cases in 27 files, 91 real-browser cases, native/WASM integration and
arena checks, and the Rust gates. The log is
`/tmp/triptych-two-mib-layout.6ztUn4/production-slices-check.log`.

No user media was opened or migrated. Portable CP/M's profile changes and CI
artifact builder are committed on `two-mib-target-profiles` at
`cf95f0f0ae7508b9b9405ba318e34d7c90b84584`; Triptych has not yet pinned those
artifacts or published a new machine configuration. Next are released profile
inputs, permanent host/tool proofs and saved-state integration under the
[roadmap](../plans/two-mib-configurable-drives.md).
