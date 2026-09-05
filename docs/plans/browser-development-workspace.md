# Browser development workspace

Date: 2026-09-06. Status: active goal; checkpoint, store, coordinator and shared
filesystem components implemented; browser integration remains in progress. Baseline: Triptych
`04e78c24523781d9012fa3ecd4eb07ec1d70d105`.

The [planning evidence](../reports/browser-workspace-planning.md) records
the independent reviews, complete baseline check and disposable application
pilot. Those results do not constitute implemented browser features.
The [disk-safety pilot](../reports/browser-disk-safety-pilot.md) records the
subsequent implementation, regression tests and remaining integration work.

The next milestone is a browser session in which a user can import source,
edit it, compile or assemble it, run it, update selected tools, and reopen
the saved work. File changes need recoverable disk backups. The mobile
terminal needs a visible cursor while the keyboard is open.

This follows the [software stability roadmap](software-stability-roadmap.md).
Its component ownership and release boundaries still apply. Work is confined
to the CPU system, primarily WASM, with native macOS/Linux replay. ATOM is
the assembler. AZM extraction, a compiler redesign, a full IDE, video, sound
and physical ESP32 qualification are outside this milestone. Development-tool
security maintenance is a separate task and release decision.

## Starting point and constraints

The browser already has whole-disk saving, download and reopening, an ANSI
80-column by 24-row terminal, mobile special keys, and edit/build/run tests.
The next changes extend those facilities. They do not require replacing the
terminal or rewriting the guest OS.

Source inspection found four constraints that affect the implementation:

- `WasmSectorStore` changes backing sectors before a guest flush. The browser
  currently reads those sectors after a frame when the flush counter changes;
  that image can also contain later, unflushed writes. Capture a checkpoint
  inside the successful flush operation.
- The persistence queue reports save errors through a callback, while
  `drain()` resolves. Manual disk changes require an acknowledged successful
  save, not merely an empty queue.
- A paused CPU can have a dirty disk cache, a partial transfer or unsaved
  editor contents in RAM. A displayed `A>` prompt proves none of these states.
  Host file changes must require an explicit save-and-exit acknowledgment,
  check the storage boundary, and start a fresh machine after commit.
- Released `NUC.COM` 0.3.1 reads one physical source file. Its second argument
  names the output, not another input. Node multipart support does not imply
  that the CP/M command has an import resolver.

The browser source is under `crates/triptych-host-wasm/web/`; the in-memory
filesystem implementation is in `crates/triptych-cpm-image/src/lib.rs`.
The latter already supplies immutable file installation, listing, reading
and capacity checks. Reuse it in WASM, with stronger validation, rather than
implementing another directory parser and allocator in JavaScript.

## Proposed disk-change workflow

Files initially lists the latest saved checkpoint, its save status, user-0
filenames, record-rounded sizes and free space. Downloads preserve CP/M record
padding; the directory does not contain an exact original byte length.

An import or tool update has the following sequence:

1. The user saves and exits the guest program, then enters disk management.
   Stop scheduling instructions and accepting terminal input. Reject a dirty
   cache, partial transfer, queued input or writes after the last checkpoint.
   An unsaved RAM warning remains necessary even when these checks pass.
2. Persist the exact checkpoint and obtain its committed revision. Retain
   the original CPU so cancellation or a pre-commit failure can resume it.
3. Build a candidate disk privately. Validate every filename and directory,
   check capacity, display canonical 8.3 names, and obtain confirmation for
   replacements. A failed batch publishes none of its files.
4. Construct a replacement CPU with the exact candidate image, without
   executing it. In one IndexedDB transaction, compare the expected revision,
   preserve the previous committed image as a recovery backup, and publish
   the candidate. Bind retries to the same operation identity.
5. Adopt the prepared CPU only after the transaction succeeds. A later boot
   failure leaves the committed image and backup available for reload,
   download or explicit restore; it does not trigger a second automatic write.

Manual mutations and autosaves share a single write coordinator. A failed
save remains retryable without waiting for another guest flush. Old queued
autosaves cannot overwrite a manual replacement after restart.

The existing whole-image Open control and backup Restore use the same guarded
replacement transaction. They cannot call the old boot-and-save path directly.
Bind asynchronous file reads to a session identity and check that identity
again before staging or activation. Disabling a control does not cancel a file
read already in progress. Reset and every terminal-input path are also gated
throughout management.

Normal Download exports an identified committed disk or named immutable backup.
A separately labelled unsaved-recovery download exports the latest exact guest
flush checkpoint after a persistence failure. It must state that the checkpoint
has not been durably saved. Live backing sectors are not a consistent recovery
checkpoint and must not be presented as one.

Normal reopening and recovery must install exact saved bytes. The current
boot helper overlays resident CCP/BDOS/BIOS bytes and immediately queues a
save; it must not be reused for exact recovery. Any resident-system upgrade
or external-image adaptation needs a separately identified, backed-up action.

### Persistence and compatibility

Upgrade the existing IndexedDB database to version 2, preserving the legacy
record and its bytes. Add revisioned publication and immutable recovery
records. A corrupt saved record enters recovery mode; it must not be treated
as an empty browser and overwritten by the distribution disk.

The upgrade must block while a deployed version-1 tab retains its connection.
Display the reason and require closing those tabs. New clients close on
`versionchange`. A writable session uses an exclusive browser lock plus
revision checks in every transaction. Without exclusive ownership, permit
read/download access and disable persistent mutations. Do not add an unsafe
version-1 fallback.

Quota exhaustion or transaction abort must leave the previous committed disk
and backups intact. Backup deletion is explicit; an update must not remove an
older recovery image automatically to make space. Browser storage can still
be cleared or evicted, so whole-disk downloads remain part of recovery.

Deployment rollback and disk restore are different operations. The baseline
website opens database version 1 and cannot reopen an upgraded profile. Retain
a tested version-2-compatible recovery build before publishing the migration;
the older deployment archive alone is insufficient. Release acceptance must
exercise migration followed by recovery-build deployment and reopening of the
preserved work. Never downgrade or delete the database to make an old build run.

### Files and tools

Keep the first Files release to the existing IBM-3740 geometry and user 0.
Preserve other users' blocks and system tracks. Reject malformed directories
and replacement of read-only files. Initially reject empty imports, matching
the existing Rust installation boundary, and display that limitation. Empty
file support can follow with shared-library tests. Never invent contents or
silently truncate names.

Publish a catalog and the exact ATOM, NUC and Edit artifacts already selected
by the distribution lock. Verify fetched bytes before staging them. Identify
installed tools by the complete expected record-padded content, not their
filenames or a version string. Report matching, missing and different/unknown
tools separately; an unknown binary may be another legitimate release.

Only selected tools change. User sources, outputs, unselected tools and sample
files remain intact. Unknown binaries require explicit replacement consent.
Catalog hashes detect mismatched deployment assets; they are not independent
signatures for the supply chain.

## Architecture selection

Two agents independently proposed the same copy-and-restart storage boundary.
The selection criteria were disk preservation under failure, the guest cache
and RAM boundary, reuse of the Rust filesystem and pinned artifacts, a small
API, and testable parallel slices. Both rejected live disk replacement, prompt
text as a safety check and a second filesystem implementation in JavaScript.

Use candidate B's compact management session as the base: begin management,
inspect, stage files or tools, cancel, and commit. Keep the baseline revision
and candidate bytes private to that session. Add candidate A's explicit
operation-identity recovery, acknowledged checkpoint barrier and exact-image
boot split. Candidate B also identified read-only file attributes and queued
terminal input as guards that need tests.

The first pilot must establish these interfaces before further fan-out:

- WASM supplies an immutable last-flush checkpoint and storage readiness.
- The store returns a committed revision or a rejected save, and atomically
  commits a replacement with its previous-image backup.
- The controller has one active management session and serializes every
  autosave and manual replacement through the same coordinator.

The independent cross-judge favoured the same base and identified the existing
whole-disk controls as a possible bypass. They are explicitly included in the
guarded workflow above. A second fresh reviewer identified the database-version
rollback gap; a compatible recovery build is now a publication requirement.
Detailed API signatures remain implementation work;
the ownership and failure rules are the constraints to preserve.

## Parallel work and review

Use up to three workers alongside the lead. Each worker has exclusive files
or a separate worktree, a bounded completion test and no authority to change
another worker's outputs. The lead owns integration, lockfiles, shared build
outputs and publication. No two jobs rebuild the same output directory at
once; local heavy tests are limited to two concurrent jobs.

| Stage                   | Parallel work                                                                                                          | Completion evidence                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 0. Design and baseline  | Two independent storage designs; separate Nucleus and mobile inspection; lead checks repository and baseline           | Compared designs, verified constraints, review findings and selected boundaries recorded before storage implementation           |
| 1. Safety pilot         | Rust flush checkpoints and disk validation; browser transactional store and migration; released Nucleus capacity pilot | Failed/stale disk commit leaves the original head unchanged; checkpoint excludes later writes; sample compiles with released NUC |
| 2. Files and artifacts  | WASM filesystem adapter; tool catalog generation; mobile cursor and focus work                                         | Native/WASM filesystem parity; exact catalog/artifact hashes; cursor and special keys work in reduced viewports                  |
| 3. Browser integration  | Lead integrates Files and update/recovery controls; independent workers build failure fixtures and sample scenarios    | Actual guest save, file import/export, selected update, cancel, restore and two-tab tests pass                                   |
| 4. Application workflow | Sample edit/build/run and native/WASM parity; independent storage and mobile review                                    | Observable changed program output; failed compile retains preceding executable; source and output survive reopening              |
| 5. Release              | Full local checks and CI; independent release-artifact inspection                                                      | Hosted assets match the tested manifest; fresh and migrated profiles pass; rollback archive retained                             |

Stage 1 is a representative safety pilot. Complete and review it before
expanding writable work across all remaining slices. Files UI integration
depends on the storage and WASM APIs; catalog and sample preparation do not.
Mobile implementation can run independently once the lead reserves its
terminal helper and test files. The lead alone integrates changes to
`app.js`, shared CSS/HTML, the build script and package locks.

### File ownership during implementation

| Slice                   | Exclusive implementation scope                                                                              | Review emphasis                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Rust disk boundary      | `crates/triptych-cpm-image/`; checkpoint and new filesystem adapter within `crates/triptych-host-wasm/src/` | Corrupt extents, allocation overlap, read-only attributes, unrelated users, full disk and exact flush bytes |
| Durable browser storage | `web/working-disk-store.js`, `web/working-disk-persistence.js`, dedicated storage tests                     | Abort/quota, retry, stale revision, old-client migration, backup retention and crash recovery               |
| Release catalog         | A new catalog helper and dedicated distribution tests; lead integrates existing builder changes             | Pinned provenance, complete padded identity, wrong target/hash, mixed deployment and selected-only changes  |
| Mobile terminal         | `web/terminal.js` helper and a separate mobile browser test; lead integrates app/CSS hooks                  | Touch tap versus Keyboard, local cursor scrolling, reduced-height landscape, focus isolation                |
| Sample program          | New sample directory and dedicated replay fixtures/tools                                                    | Released-compiler capacity, console CR/LF, win/quit/error paths, failed compile and cross-host parity       |
| Integration             | Lead-owned workspace controller, `app.js`, HTML/CSS, build/package wiring and shared reports                | End-to-end behavior, no competing autosaves, exact-image recovery and publication                           |

Paths prefixed `web/` in this table are relative to
`crates/triptych-host-wasm/`. Reviewers receive the diff and its callers,
invariants and acceptance tests. At least two fresh, read-only reviewers
challenge data-integrity changes. A contributor's self-review is not an
independent review. The lead reproduces consequential findings, resolves
them and reruns the affected tests. Browser integration gets a further review
across component boundaries.

## Mobile and sample scope

The mobile layout already provides reduced-height keyboard mode. Keep the
guest at 80 by 24 and preserve readable horizontal scrolling. Reveal a moving
cursor within the terminal's own scroll area; avoid page-level scrolling
that displaces the keyboard. Test both terminal touch-tap and Keyboard entry,
Done exit, 390 by 400 portrait, reduced-height landscape and all special keys.
Opening Files must isolate its text input from the guest and clear the Ctrl
latch. Closing Files must not automatically summon the terminal keyboard.

Automated Chromium viewport evidence is separate from physical Android/iOS
keyboard qualification. Real keyboard appearance, dismissal and composition
remain a device check; neither desktop resizing nor a screenshot fixture
proves them.

Start the sample with a tiny single-source choice game and measure the released
compiler's capacity before adding content. Use explicit CR/LF handling or
single-key choices. Do not describe a source file plus README as a multi-file
source application.

The initial disposable pilot passed on retained WASM and macOS binaries:
671 source bytes, two locations, E/W movement, invalid-key and CR/LF handling,
and Q back to CP/M. Nine output checkpoints and the complete disk matched.
It has no item or win condition yet, and remaining compiler capacity has not
been measured. Adopt it into permanent tests only after review and the
edit/recompile and failure-preservation checks.

A genuine multi-file CP/M source build remains a decision gate: qualify a
source-packaging adapter against Nucleus's existing multipart contract, or
explicitly defer that part of the goal. It is not currently a released
`NUC.COM` capability. The storage and mobile stages can proceed while that
integration cost is measured. Compiler redesign is outside this plan, and
the whole goal cannot be declared complete by relabelling a single-file demo.

## Final acceptance and next step

Use a disposable copy of an existing saved disk and a fresh browser profile.
Import source, edit and save it, build with ATOM or NUC, run the changed
program, update a selected tool, close the browser, and reopen. Compare
preserved source/output and unselected-tool bytes as well as terminal text.
Download a recovery image and reopen it in a separate profile and native host.

Fault tests cover invalid names, corrupt directories, a full CP/M disk,
read-only targets, failed artifact verification, blocked migration, two tabs,
quota failure, cancelled confirmation and interruption during commit. Repeat
the guest workflow on the native host. Run `npm run check`, then CI and
published-asset verification against the exact release candidate. Record
physical-phone and ESP32 gaps separately.

Two targeted race tests are required: resolve a delayed file read after its
session is superseded and prove the CPU and disk head are unchanged; flush
image A, perform later unflushed writes B, and prove recovery download still
equals A byte-for-byte.

The next implementation step is browser integration of the single-writer
coordinator and a WASM wrapper for the strengthened shared Rust filesystem.
The exact-flush checkpoint is integrated into autosave/download; the tested
revisioned store and coordinator remain disconnected from the app until exact
recovery and migration-safe activation are ready.

The sample's edit/recompile sequence passed on both hosts, but malformed
`sub main(` source exposed a failure to return to CP/M after the compiler
diagnostic. The prior executable survives and runs after a fresh boot.
The diagnosis identified a CCP transient return address inside the default
disk DMA buffer. Correction and regression tests belong in Portable CP/M;
Triptych must consume a reviewed upstream release rather than patch its snapshot.
The reviewed upstream correction now passes the invalid-source return and
preserved-program replay on both hosts. Publication and the consumer pin update
can proceed independently of storage. The full browser milestone remains active
until its release and recovery proofs pass.

### Next parallel wave

| Owner           | Work                                                              | Gate before integration                                                                                 |
| --------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Lead            | Exact-image boot, coordinator wiring, Files and recovery controls | All input and whole-image paths use the same guarded lifecycle; migration and recovery-build tests pass |
| Rust worker     | WASM bindings for validated listing, reading and batch import     | Actual WASM results match shared-library results and preserve original bytes on failure                 |
| Artifact worker | Catalog of the pinned ATOM, NUC and Edit binaries                 | Downloaded artifacts and installed record-padded identities match exact hashes                          |
| Mobile worker   | Local cursor reveal and keyboard/focus isolation                  | Touch and Keyboard paths pass reduced-height tests; physical-phone evidence remains separate            |

When a worker finishes, use its slot for independent review or the sample
packaging experiment. Publish and consume the reviewed CCP correction through
the existing component-release process. Then replay the whole browser workflow,
including a failed compile, before CI and Pages publication.
