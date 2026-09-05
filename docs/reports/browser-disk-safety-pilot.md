# Browser disk-safety pilot

Date: 2026-09-06. Baseline: `04e78c24523781d9012fa3ecd4eb07ec1d70d105`.
Branch: `browser-development-workspace`. Status: locally verified,
independently reviewed; not published.

This report records the earlier safety checkpoints. The subsequent
[browser integration report](browser-workspace-integration.md) supersedes its
remaining-work list and inactive-component status.

## Implemented boundary

The WASM host now captures an independent disk checkpoint inside each
successful guest flush. Browser autosave and Download working disk use that
checkpoint. They exclude subsequent unflushed sector writes and unsaved
editor contents. A checkpoint can still be newer than the browser's durable
saved copy; the footer states that distinction.

`export_drive()` retains its existing live-backing semantics for diagnostic
and headless consumers. `export_drive_checkpoint()` returns a copy of the
initial image or last successful flush. `disk_management_ready()` checks
dirty cache, partial transfer, controller error, unflushed backing writes and
pending console input. It cannot prove that an application saved its RAM or
completed a logical filesystem operation.

Serial status reads can prefetch a byte into the CPU core. A read-only
`Machine::console_input_pending()` accessor exposes that state so the host
readiness check includes both the host queue and the prefetched byte.
Guest ports, timing rules and serial behavior are unchanged.

The new `working-disk-revisions.js` implements a separate transaction-layer
pilot: revision-checked saves, atomic pre-change backup and replacement,
operation-identity retry, legacy-data migration, and raw legacy recovery.
It is deliberately absent from the browser build and app imports. Existing
profiles remain on version 1 until the management coordinator and a compatible
recovery build are integrated. This temporary inactive path must be consolidated
with the existing store at that integration stage.

## Regression evidence

The ATOM-assembled `test/wasm/fixtures/flush-checkpoint.asm` performs real guest
I/O: write record A, flush, overwrite it with B, then evict the dirty sector
without another flush. The test leaves a read transfer active and halts.

Before the browser fix, the regression observed 128 bytes of B (`66`) in
IndexedDB where 128 bytes of A (`65`) were required. After the fix, the same
browser test passed and its downloaded image exactly matched the saved
checkpoint. The test also creates a separate WASM host and verifies complete
checkpoint/live image bytes, readiness before and after execution, rejected
media replacement after execution, and a missing-drive error.

The Rust worker separately demonstrated a failing-before unit regression:
the old live-export behavior returned later byte 2 instead of flushed byte 1.
The corrected checkpoint test passes. Nine WASM-host unit tests cover copies,
per-drive state, initial checkpoints, failed writes, unchanged writes requiring
a flush, controller hazards and pending input. Four CPU-core unit tests and
the language-neutral conformance test also pass.

Ten real Chromium IndexedDB tests exercise the inactive transaction layer:

- copied snapshots and reopening;
- competing connections and stale publication;
- repeated operation identity, mismatched payload and a newer head;
- transaction abort and injected quota failure after a queued head write;
- asynchronous duplicate-key failure with rollback and successful retry;
- an old connection blocking migration;
- quota failure during migration, original-version preservation and retry;
- malformed legacy data remaining recoverable and preventing replacement;
- connection closure when a subsequent version upgrade is requested.

The quota test injects the browser exception; it does not exhaust physical
device storage. The duplicate-key test exercises an actual asynchronous
IndexedDB request failure. All databases are disposable test-profile state.

## Independent review and final checks

Two fresh read-only reviewers examined the full storage module/tests, Rust
changes, browser call sites and guest fixture. One reviewer reproduced a
migration callback exception that lost the original quota error and emitted
an uncaught page error. Chromium still rolled back the database safely.
The worker added a guarded migration callback, preserved the original error
and added the regression test. The reviewer confirmed the correction.
Neither reviewer reported another actionable pilot defect.

The lead read the implementation and ran the public browser regression, then
`npm run check` completed with exit code zero. This includes TypeScript,
CP/M/ATOM proofs, browser tests, native terminal and cross-host parity, Rust
format/lint/tests, and the WASM release build. The successful local tool paths
are recorded in the [planning report](browser-workspace-planning.md).

## Sample failure found in parallel

The disposable application test now uses actual CP/M Edit to replace `CAVE`
with `BASE`, save, compile and run. That sequence passes on the retained
published WASM and copied macOS native hosts.

Removing `)` from `sub main()` and recompiling produces:

```text
Nucleus error 86 P=01 O=00D5 L=0009 C=000B
```

The compiler does not return to `A>` within the test budgets on either host.
The WASM sample has PC `0x821f`, SP `0x0100`; native execution reaches its
100-million-instruction limit. The prior `GAME.COM` remains byte-identical
and runs after a fresh boot. This is a failing error-return qualification,
not a passing recovery test.

A separate read-only investigation traced the failure to Portable CP/M's CCP.
The transient loader sets SP to `$0100` and pushes its zero return address at
`$00FE`. NUC uses the documented default DMA buffer, `$0080..$00FF`, for source
reads. The read replaces that return address with `$7361`, the source characters
`as`. NUC restores its incoming stack correctly; its final `RET` consequently
jumps into source RAM. The lead reproduced the instruction trace.

Replacing only the CCP in a disposable disk with the retained compatibility
binary gives the same compiler diagnostic followed by `A>`. That CCP supplies
a caller stack outside DMA. No historical source was read or translated.
The correction belongs in the authoritative Portable CP/M repository, followed
by an upstream release and Triptych dependency update. It must cover sequential
and random default-DMA reads, return control flow and resident-stack guards.

Local evidence and scripts are in
`/tmp/triptych-browser-plan.nlKRrH/adventure-pilot/EDIT-RUN.json`, with
`edit-result.json`, `native-edit-result.json` and `recovery-result.json`.
The preceding executable hash is
`f9afbab3da0ce918cce2f8d17ef9b77a00e1216a8634f62295a884ba1875ca1a`;
the preserved final disk hash is
`06343b1a74a568c480b144a5bc0baf890b9163c0e6ddee5300cead0fab9b0809`.
This new failing sample is outside the currently passing root check corpus
and must become a permanent regression when the CCP correction is consumed.

## Parallel filesystem and coordination work

The next wave used three independent writers: the shared Rust filesystem,
the browser management coordinator, and the Portable CP/M stack correction.
Each had exclusive files. The lead added real browser lock tests and replayed
the corrected CCP with the retained NUC, native host and WASM host.

`crates/triptych-cpm-image/src/lib.rs` now validates occupied entries for every
CP/M user before listing, reading or importing. Every nonzero allocation pointer
is reserved, including preallocated blocks beyond the record count. Imports
reject read-only targets and ambiguous physical names. Immutable batches release
all replaced files' capacity before allocating their replacements. Other users,
system tracks and host-sector padding remain intact. Sparse layouts and short
non-final extents are explicitly unsupported; raw disk recovery remains possible.
The worker demonstrated four failing-before cases and passed 20 unit tests,
two CLI tests and Rust lint checks. The WASM adapter is still required.

`disk-workspace.js` serializes checkpoint saves and manual publication through
one queue. Management captures a private baseline after an acknowledged save;
candidate preparation precedes publication, and CPU adoption follows it.
Session tokens reject delayed reads after cancellation. Retry uses the same
operation identity and checks the current head before activation. Ambiguous
publication or activation failure leaves execution stopped for recovery.

Eighteen deterministic Node tests cover these transitions and run through the
normal check command. Three real Chromium tests cover exclusive ownership across
tabs, explicit release, release when a tab closes, and unavailable lock support.
The coordinator and revisioned store remain inactive in the app; these tests do
not qualify their eventual UI integration or migrate an existing profile.

The Portable CP/M correction changes the transient stack operand to the existing
resident stack top. Its four ATOM regression cases cover sequential/random reads
with either a retained or private program stack. They inspect the actual return
word, SP and PC, the guard before warm-boot reload, a later command and disk
preservation. The owning repository's full check passed, including 278 tests.
Code size, reserved storage and launch instruction timing are unchanged.

The lead's `nuc-error-diagnosis/fixed-replay.mjs` probe installs only that corrected
CCP in the disposable Edit-produced invalid-source disk. Both retained hosts
produce the exact diagnostic, return to CP/M, run the preserved game, quit and
execute a subsequent command. Five transcript checkpoints and the complete final
disk match. The corrected CCP hash is
`e74d61f096f6c9de01d77cd990a3255c4f0d46d771992a5e54b7993ed51fe18b`;
the final disk hash is
`aeebef7e99ca9b1ee29d739d8ca517b0b6946d629b7975a50bbf762ddba45694`.
This is host-model consumer evidence, not an upstream release or a Triptych pin
update. The full Edit sequence still needs a permanent test against that release.

Two fresh read-only reviewers independently examined this entire wave. Both
reported no outstanding actionable findings. One identified missing normal-check
wiring for the coordinator tests; the lead had added it, and the reviewer
verified the resulting command. Both independently ran the 18 Node tests.
The lead's subsequent full `npm run check` passed, including all 22 browser tests,
native terminal restoration, native/WASM parity and workspace Rust checks.

## Remaining work

The management coordinator must be wired into every app input, Reset, Open,
autosave and replacement path. Exact-image reopening, recovery UI and a
version-2-compatible deployment recovery build remain required before migration
is activated. The new Files UI must use the strengthened shared Rust library.

The Rust filesystem adapter, Files panel, tool catalog/update UI, mobile cursor
changes, complete application workflow and hosted publication remain pending.
Multi-file source packaging is still separate from the released single-file
NUC command. No physical-phone or ESP32 qualification is claimed.
