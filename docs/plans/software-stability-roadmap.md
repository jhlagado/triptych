# WASM-first software stability roadmap

Date: 2026-09-05. Status: active goal; S0 and S3 complete, S1 in progress. This is
the current cross-project execution plan. Component
contracts remain authoritative; earlier reports retain their dated results.

## Stable release target

The release must support one repeatable development session: boot Triptych in
the browser, create or change a file in Edit, save it, assemble with ATOM or
compile with NUC, run the resulting program, close the session, and reopen the
saved work. The same guest programs must run on the macOS host and in Linux CI.
An exported disk must work in a fresh host without a Debug80 checkout.

Completion requires reproducible source-to-artifact builds, explicit component
versions, passing compatibility tests, recoverable browser storage, and a
verified Pages deployment. It does not require an ESP32 board. Compatibility
claims apply to the published feature matrix and application corpus, not every
CP/M program ever written. Full IDE development, new languages, video, sound,
Windows-specific support and a replacement Z80 emulator are outside this goal.

## Component ownership

The subsequent ownership decision separates portable CCP/BDOS into their own
OS project, while the Triptych BIOS stays with the machine. The
[component release plan](component-releases.md) defines the source, dependency
and disk-building boundaries. The OS name/remote remains pending. Edit has
reached its first independent release, and both Triptych and Debug80 now
consume that pinned artifact.

| Component             | Source authority                                                          | Role and boundary                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ATOM                  | Standalone `atom` repository                                              | Assembler, native guest binaries and public host API. Required assembler for normal builds and tests.                                |
| Nucleus / `NUC.COM`   | Standalone `nucleus` repository                                           | Language, compiler, runtime and platform adapters. Uses ATOM; preserves Node and other target support independently of Triptych.     |
| Edit / `EDIT.COM`     | Standalone [`jhlagado/edit`](https://github.com/jhlagado/edit) repository | Editor core plus explicit terminal, filesystem and target-memory contracts. Triptych consumes the pinned `v0.1.0` application.       |
| CCP and BDOS          | Future standalone OS repository; transitional sources remain in Triptych  | Portable guest operating-system layer, qualified through public CP/M interfaces. The repository name and remote are still pending.   |
| BIOS and bootstrap    | Triptych `system/cpm/` and `roms/cpu/`, respectively                      | Machine-specific console, disk, boot and warm-start implementation. Remain with the machine.                                         |
| CP/M distribution     | Triptych image tooling                                                    | Versioned composition of resident components, applications and sample files. Historical binaries are separately identified fixtures. |
| Rust CPU core         | Triptych `crates/triptych-cpu-core/`                                      | Portable guest execution and machine state. No browser, native filesystem or editor policy.                                          |
| WASM and macOS/Linux  | Triptych host crates                                                      | Browser or terminal input, scheduling and host storage around the same Rust machine.                                                 |
| ESP32-S3              | Triptych `firmware/cpu/`                                                  | Future physical console/storage adapters and CPU firmware; existing build evidence is not physical qualification.                    |
| Debug80 Runtime       | Standalone `debug80-runtime` repository                                   | TypeScript Z80 engine and headless Node support. Development-only adapter in Triptych.                                               |
| Z80 Tool Services     | Standalone `z80-tool-services` repository                                 | Shared language-neutral host/native service contracts and tests. No machine or editor ownership.                                     |
| Debug80               | Standalone `debug80` repository                                           | Optional IDE/debugger consuming released tools and runtime. No Triptych production dependency.                                       |
| Development workspace | Local `z80-workspace` launcher                                            | Optional pinned multi-repository checkout/build orchestration; never the authority for component source.                             |

CP/M is the guest operating environment. WASM and macOS are hosts for the
Triptych machine. ATOM, NUC and Edit are applications with their own lifetimes.
This distinction permits another Z80 platform to use those applications
without adopting the Triptych machine or Debug80 IDE.

```text
ATOM ──builds──> Nucleus, Edit, Triptych resident software
                     │         │
                     └────┬────┘
                          v
                 versioned CP/M disk
                          │
                   Triptych Rust core
                    /      |       \
                WASM    macOS/Linux  ESP32 later

Debug80 ──consumes──> ATOM, Nucleus, Runtime, Tool Services
Node CLI/tests ─────> standalone Runtime and tool APIs
```

## Verified starting point

The repository inventory is retained in the
[baseline report](../reports/software-stability-baseline.md). Its revisions
describe the starting state, not a release lockfile.

- Triptych already boots its own CCP, BDOS and BIOS. Rewriting them again is
  unnecessary. CCP has all six built-ins, but parser boundaries, mutation
  recovery and worst-case resident stack proofs remain incomplete.
- BDOS has recorded direct-call coverage for functions 0–40 and filesystem
  failure tests. Those results must survive the assembler migration.
- The Rust native and WASM hosts and the headless scenario format already
  exist. Pages publication also exists; the deployed artifact was not freshly
  fetched during this inventory.
- The browser currently has an in-memory working disk with whole-image
  download. Reload-safe browser storage is unfinished. Mobile viewport tests
  partly inspect source strings; they do not prove a physical phone keyboard.
- Nucleus reconciliation has ATOM-generated images and focused passing tests
  in an unpublished worktree. Remaining proof helpers still use AZM. Atom's
  own release scripts also retain AZM calls.
- Triptych's current image helper still assembles resident software with AZM.
  Its ordinary proof paths share this dependency. The migration must precede
  executing those paths under the user's ATOM-only policy.
- Edit source and extensive editor tests remain in Debug80. Triptych's
  bundled executable is not a reproducible build of a separately released Edit.

## Execution order and acceptance gates

Stages are accepted individually with a report, exact revisions and commands.
The default order is S0 through S7. Browser storage work in S5 can proceed
against existing fixtures while toolchain work continues, but final acceptance
must use the rebuilt distribution from S4. No milestone is complete merely
because its implementation compiles.

### S0 — baseline and release rules

Status: complete; the [checkpoint report](../reports/software-stability-baseline.md#s0-implementation-checkpoint)
records passing readiness tests and the guarded full-check failure.

Record source owners, current revisions, dirty worktrees, unpublished work and
dependency directions. Preserve the Nucleus reconciliation and the separate
compiler-rewrite work. Correct repository guidance that still permits AZM in
production. Separate CCP software publication readiness from ESP32 physical
qualification without marking incomplete software rows proved.

Exit: one current roadmap, a reproducible inventory, explicit ATOM guidance,
and tested readiness rules that permit a software release before board tests.

### S1 — ATOM-only toolchain and Nucleus reconciliation

1. Finish Nucleus's remaining source-assembly proof and runtime-harness
   migration. Preserve newer standalone language/runtime features and the
   recovered Atom conversion. Use its existing public host API and prebuilt
   images; do not introduce assembly at installed application runtime.
2. Convert Atom's bootstrap, native-object harness and CP/M build scripts to
   its self-hosted assembler. Record the bootstrap seed's provenance and
   digest, then prove repeat-generation equality. A declared bootstrap seed
   is preferable to an undeclared AZM dependency.
3. Convert Triptych bootstrap/BIOS syntax and shared proof/image assembly to
   the pinned public ATOM API. Preserve resident slots, entry points, emitted
   bytes and symbol contracts, accounting for every intentional difference.
4. Remove AZM from these ordinary build, test, measurement and CI paths.
   Historical executable comparisons remain isolated and explicit. Completed
   assembler comparisons must not remain permanent build prerequisites.
5. Verify packed packages and clean installation before publishing reconciled
   revisions and advancing downstream pins. Never advance a consumer to an
   uncommitted worktree or silently overwrite newer Nucleus work.

Exit: ATOM, Nucleus and Triptych normal builds and relevant proof suites run
with AZM unavailable. Compiler images regenerate deterministically; the
language, relocation, import and host tests pass. Triptych's full check and
headless execution pass with the ATOM-built resident software.

### S2 — CCP completion and operating-system qualification

Extract CCP and BDOS together into the independently released OS project once
its name and remote are selected. Preserve their source history, interface
contracts and component proofs. Separate configurable placement from portable
behavior and prove an alternate headless target. Triptych consumes a pinned OS
release and retains its integration tests. Its BIOS stays in Triptych at
`system/cpm/bios.asm`; the real bootstrap remains under `roms/`. The
[BIOS placement checkpoint](../reports/bios-placement-migration.md) records
the caller migration and byte-equivalence proof.

Finish the existing CCP matrix rather than adding a richer shell. Cover long
and malformed commands, decimal overflow, wildcard/filename limits, extra
operands, full/read-only/faulted disks and a valid command after every failure.
The [SAVE overflow checkpoint](../reports/ccp-save-overflow.md) records the
failing-before reproduction and correction for `SAVE 1280 X.COM`. Broader
generated parser boundaries and malformed-command recovery are covered by the
[parser qualification checkpoint](../reports/ccp-parser-qualification.md). The
[extra-operand checkpoint](../reports/ccp-extra-operands.md) records the
failing-before `DIR` and `TYPE` cases and their end-of-command checks. The
[filename-boundary checkpoint](../reports/ccp-filename-boundaries.md) records
the failing-before truncation cases and the shared FCB overflow signal. The
[drive-prefix checkpoint](../reports/ccp-drive-prefix-boundaries.md) records
the failing-before `Q:` case and the enforced `A:` through `P:` range.

Define replacement and partial-write behavior explicitly. Current SAVE deletes
an existing target before creating its replacement; blanket transactional-save
claims would be incorrect. Tests must check the documented outcome, preserve
unrelated files and prove command recovery. The
[failure-recovery checkpoint](../reports/ccp-failure-recovery.md) fixes the
read-only, full-directory, full-disk and failed-I/O outcomes, including the
empty partial file left by a full-disk SAVE. Prove worst-case CCP stack and
resident-size bounds with canaries and paths exercising failure handling. The
[resident-stack checkpoint](../reports/ccp-resident-stack.md) fixes the stack
shape, guards its lower boundary and records a ten-byte low-water result
across the current success, failure and transient-return corpus.

Rerun BDOS's direct-call, extent, directory-failure and randomized filesystem
tests. Retain original implementation through published interfaces and
black-box observations; historical CCP/BDOS source is not implementation input.
Keep BIOS with Triptych. Drive A, fixed disk geometry and the existing console
profile remain the supported baseline; multi-drive and physical SD recovery
are separate changes.

Exit: the OS builds independently and Triptych consumes its immutable release;
every required CCP software row is proved; BDOS and BIOS regression gates
pass; incompatibilities and deliberate limits are listed. Hardware status
remains independent and unqualified.

### S3 — independently maintained Edit

Status: complete. Standalone release `v0.1.0`, the
[release checkpoint](../reports/edit-standalone-release.md), and the
[persistent workflow checkpoint](../reports/edit-nucleus-persistent-workflow.md)
record the source, consumer and behavioral gates.

Inventory and extract the exact editor-owned source and proof history from
Debug80. Preserve its buffer, navigation, search/replace, ANSI screen and
temporary/backup-file save tests. Replace the proof script's AZM sidecar with
ATOM before treating the build as the released editor. The
[Edit extraction manifest](edit-extraction-manifest.md) records the current
authority, history, portable proof boundary and consumer migration gates.

Keep the current CP/M target first. Document buffer ownership, console bytes,
file operations and memory placement before making those interfaces
configurable. Existing fixed addresses and 80×24 geometry are constraints,
not evidence of portability. Add an adapter seam where it is needed for a
second platform; do not create a general IDE framework in this stage.

Triptych and Debug80 then consume the same versioned editor artifact. Remove
the old source copy only after extraction, tests and consumer migration are
verified. Public release `jhlagado/edit` `v0.1.0` pins revision
`ac59b478b686b7cd1a3a340064e82d64fdc58589` and the 3,003-byte application
digest `bbe4ac2b6236d178089fcd01822d0d7fa3c6159f0d2da3655eba1212dda5aa02`.

Exit: Edit builds and tests outside Debug80 with ATOM. Its current editing and
save-error behavior is preserved. A full edit/save/search/replace session runs
against Triptych's current BDOS, not only the historical fixture.

### S4 — reproducible system and application distribution

Use the input-lockfile/output-manifest distinction and the verified build
sequence in the [component release plan](component-releases.md). Cargo manages
Rust code dependencies; guest OS/application artifacts remain a separate
release boundary. Triptych BIOS is selected by the Triptych build revision.

Replace reliance on inherited demo application binaries with a declared
distribution manifest. Pin source revisions and build inputs for CCP, BDOS,
BIOS, ATOM.COM, NUC.COM and EDIT.COM; record binary digests, memory limits and
licences. Keep reviewed historical fixtures separately identified.

Build a deterministic disk from those artifacts and versioned sample sources.
Verify directory/allocation consistency, filenames, text EOF conventions and
available space. Keep `NUC.COM` as the short user command. Distinguish a release
disk from a user's writable disk; upgrade and reset actions must not erase
working files without explicit selection and a recoverable backup.

Exit: two clean builds with the same manifest produce the same distribution;
each executable is traceable to source. A clean checkout needs no unpublished
sibling directory, Debug80 monorepo source or AZM installation.

### S5 — usable and recoverable WASM development sessions

Specify a browser-owned persistent disk store, separate from the Rust machine.
Use committed disk snapshots and explicit save status: a guest BDOS save and a
completed browser-storage transaction are distinct events. Test reload,
session replacement, denied/quota-exhausted storage, interrupted persistence
and recovery after a machine error. Retain whole-disk import/export and prove
an actual download/reimport workflow. Individual-file browser tooling and
multiple working-disk management can follow after this baseline.

Verify the unified terminal tap and Keyboard-button focus behavior. Keep the 80×24 guest
contract while documenting narrow-screen scrolling/scaling and cursor
visibility. Test viewport changes, orientation, paste, control keys and editor
status-row access. Replace source-string-only layout assertions with browser
interaction tests. Bound input/output backlog and test long-running sessions.

Exit: desktop browser automation proves edit → save → compile → run → reload
→ reopen, including a failed save and recovery. Narrow-viewport automated tests
pass. Physical Android/iOS keyboard behavior gets a separate evidence row; if
devices are unavailable, mobile support remains explicitly provisional rather
than being declared universally qualified.

### S6 — macOS/Linux parity and Debug80 consumption

Run the same guest workflows through headless WASM and the native host. Compare
raw console bytes, terminal snapshots and exported file/disk contents at
defined checkpoints. Prove native terminal setup/restoration through PTY
tests. Investigate software flow control intercepting Ctrl-S/Ctrl-Q, and
document guest Ctrl-C versus host-exit behavior before changing it.

Update Debug80's standalone dependency pins after their release gates pass.
Move remaining editor-owned code out through S3, keep Glimmer out of the
shipping subset, and make ATOM the normal assembly path. Preserve only
explicit historical AZM compatibility fixtures; do not route active Nucleus,
Edit or Triptych work through them. Verify the extension package contents and
fresh installation, not merely TypeScript compilation.

Resume the optional workspace launcher with immutable revisions and no AZM
support checkout on its default path. Keep the TypeScript runtime for Node
CLI/tests and Rust for Triptych hosts. Their existing conformance boundary is
sufficient; a universal Rust/Node runtime replacement is deferred.

Exit: macOS reference sessions and Linux CI pass; Debug80 can consume the
standalone releases without owning their source. Triptych builds and runs
independently. No default path depends on local links or a historical AZM build.

### S7 — CI, publication and stable release

Run non-publishing checks on pull requests and promote only verified artifacts
to Pages. The release gate includes `npm run check`, actual
`npm run proof:cpm-headless` execution, real-browser workflow tests, native
persistence/PTY tests and the clean-build proof. Root `check` validates
scenario definitions but does not itself execute the entire headless suite.

Publish the exact tested artifact with its manifest. Fetch the hosted assets,
check digests/revision, boot to the prompt and perform an application smoke
session. Retain a previous release for rollback. Document startup, backup,
restore, supported commands, known limits and one short acceptance session.

Exit: all S0–S6 gates have linked evidence and the fetched Pages build passes.
There are no known work-loss or core-workflow failures in the supported
profile. Record the stable component revisions and remaining limitations;
only then mark this software goal complete.

## Subsequent ESP32 milestone

When the boards are available, identify their exact module/flash/PSRAM and USB
configuration, flash the CPU conformance firmware, and retain physical results.
Then qualify a breadboard microSD connection using scratch media, implement
the physical sector-store and console adapters, and replay the same guest
workflow. Measure sustained execution, reset behavior and durability on the
board. Do not infer SD power-loss safety from host filesystem tests.

The existing [CPU development plan](cpu-development.md) supplies the detailed
hardware gates. GPIO, connector and timing choices remain experimental until
measured. VDP and sound implementation require a later roadmap.

## Progress discipline

Every checkpoint records changed repositories, revisions, tests actually run,
unresolved failures and the next concrete task in `docs/reports/`. Component
contracts belong in their owning repositories; cross-module machine contracts
remain in `docs/specifications/`. This plan coordinates releases, not source
ownership. Existing reports must not be rewritten to imply new measurements.

Triptych's source migration is recorded in the
[ATOM build checkpoint](../reports/atom-build-migration.md). Its shared image
and test helpers now use ATOM; the baseline section above records the earlier
starting state. Nucleus's development runtime and manifest helpers also use
ATOM, and its first full-size flat-target proof has passed.

Triptych's full check and 29 headless WASM scenarios now pass after a fresh
installation. The missing-bundle investigation identified an npm symlinked
cache-path problem; the unchanged ATOM pin passes the new Git/offline consumer
check using canonical temporary paths.

The local [ATOM-only release checkpoint](../reports/atom-only-release-checkpoint.md)
records completion of ATOM's normal build and verification migration, including
358 passing tests with AZM blocked and an offline package installation.

The [final-byte checkpoint](../reports/atom-final-byte-and-nucleus-relocation.md)
records the qualified ATOM correction and the Nucleus relocation migration.
The published ATOM pin now passes Nucleus's fresh-install generated-image,
relocation and 36-test compiler checks. The
[proof-ordering checkpoint](../reports/nucleus-proof-ordering.md) records the
three corrected fixture layouts and the host-deadline changes. Its complete
24-test manifest suite now passes; clean release qualification and publication
remain before downstream pins can advance. S1 remains in progress until both
standalone toolchain gates pass.

The [WASM working-disk checkpoint](../reports/wasm-working-disk.md) records the
first reload-safe browser storage path and a live local save/reload proof. It
is superseded for interaction coverage by the
[real-browser acceptance checkpoint](../reports/wasm-browser-acceptance.md),
which drives Edit, NUC, reload, download/reimport, storage failure, paste and
the reduced mobile layout in Chromium. Physical mobile-keyboard behavior and
long-duration backlog limits remain explicit S5 follow-up work.

The [standalone Edit checkpoint](../reports/edit-standalone-release.md) records
the preserved history, ATOM-only `v0.1.0` release, passing macOS/Linux proof and
Triptych's verified release input. The
[persistent Edit–Nucleus checkpoint](../reports/edit-nucleus-persistent-workflow.md)
proves the complete search/replace/save/compile/run/reopen loop and preserves a
CCP `TYPE`-then-transient regression test. Debug80 revision `6e1aa910` removes
the duplicate editor source and proof suite while retaining its CP/M consumer
acceptance and verifying the same `v0.1.0` artifact.

The first user-visible milestone is the ATOM-built Triptych browser image;
the main usability milestone is S5's persistent edit/build/run session.
