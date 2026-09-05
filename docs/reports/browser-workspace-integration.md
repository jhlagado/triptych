# Browser workspace integration

Date: 2026-09-06. Branch: `browser-development-workspace`.
Status: integrated locally; not published. The active goal and release gates
remain in the [roadmap](../plans/browser-development-workspace.md).

## Implemented surface

The Files dialog lists and downloads committed user-0 files through the shared
Rust filesystem's WASM binding. Imports validate CP/M names, attributes,
directory structure and capacity before staging an immutable candidate.
The actual WASM binding is compared with the native image utility.

The build emits a catalog and content-addressed ATOM, NUC and Edit binaries from
the pinned distribution. Installed identity includes every padded record byte.
Fetched updates require matching target, source identity, length, raw hash,
padding and padded hash before staging. Only selected files change; an unknown
binary requires explicit replacement consent. Catalog hashes detect mixed
assets, not compromise of the entire publishing origin.

All persistent app writes now use the revisioned store and single-writer
coordinator. The old version-1 writer is removed. Its record decoder remains
for migration. Existing disk bytes reopen exactly, without resident-system
overlays. Optional adaptation is a separate acknowledged image-import action.

Files isolates guest input and the mobile Ctrl latch. Cursor reveal scrolls
only the terminal element, preserving the 80×24 guest screen. Touch and Keyboard
entry pass reduced-height portrait and landscape tests. Those tests simulate
viewports; physical Android/iOS keyboard behavior remains unqualified.

## Review corrections and evidence

Two independent reviewers examined the integrated changes. Their findings
identified distinct reachable faults; the lead verified and corrected each:

- A delayed selection within one management session could supersede a newer
  selection. Staging now checks both session and action generations.
- Closing Files during an awaited management-entry save could leave a paused
  CPU behind a closed dialog. The eventual session is cancelled before adoption.
- Boot-asset download failure prevented opening recovery storage. Storage now
  opens first, preserving saved-disk downloads when boot downloads fail.
- A committed but unbootable image could not pass ordinary readiness checks,
  so restoration was inaccessible. Explicit saved-disk recovery now pauses
  execution and loads the durable head without exporting or saving unsafe
  live guest state. Ordinary readiness checks remain unchanged.

The recovery worker added eight failing-before coordinator cases, then the
implementation and nearby cases passed all 28 coordinator tests. A reused
reviewer independently reran those tests and found no remaining correction
issues. This fix readback was not a new independent panel.

The lead's actual browser regression imports a 512-byte zero disk, commits it,
reloads into boot failure, confirms ordinary entry is rejected, enters explicit
recovery, restores the saved backup and reloads to `A>`. The complete restored
image matches the original, and both displaced images remain backed up. The
test failed before the recovery control existed and passed after integration.

Other actual browser cases cover import/export and `TYPE`, cancelled and invalid
imports, selective unknown-tool update, failed asset verification, exact legacy
migration, second-tab read-only behavior, transaction abort and retry, exact
backup restore, stale reads, corrupt legacy retention and boot-download failure.
Injected quota errors exercise transaction failure, not physical storage limits.

The lead's complete `npm run check` passed after integration: 43 actual browser
tests, 274 TypeScript/JavaScript tests, the 28 coordinator and 10 catalog Node
tests, CP/M/ATOM proofs, native terminal and cross-host parity, Rust formatting,
lint and workspace tests, and the WASM release build. The deployment checker
also verified all 23 emitted assets in the local dirty development build.
Documentation formatting was checked again after the report update.

## Release work still required

The corrected CCP is committed in Portable CP/M as `6dc1269`; Triptych still
consumes v0.1.0. A v0.1.1 release needs a package-version update, passing CI and
publication of those exact artifacts. Triptych needs a verified release import,
updated provenance and replayed scenario digests. The retained snapshots must
be copied from the immutable upstream revision, not edited as a second source.

The multi-file adventure remains a separate qualification step. A worker's
private prototype maintains `IO.NU` and `MAIN.NU` separately, then generates a
689-byte `GAME.NU` for the released single-input CP/M compiler. The lead reran
the proof: actual NUC 0.3.1 compiled the bundle in WASM with the corrected CCP;
the game started, moved east/west and quit. A deliberate syntax error mapped
from bundle offset 230 to `MAIN.NU` offset 28, line 2, column 10, matching the
released Node multipart diagnostic. The preceding executable survived.

Evidence is in `/tmp/triptych-multipart-pilot.hUZvdy/pilot.mjs` and `result.json`.
The generated source SHA-256 is
`154a230a351179959cbb35115859b10eef512c7220c4ad442b545eccf10cb7ae`.
This proves one host-assisted source bundle, not CP/M import resolution or
native multipart transport. The prototype is not installed in the browser.
It still needs boundary/EOF/CRLF tests, stale source-map protection, a game win
condition, actual Edit/repackage replay and native-host qualification.

Before publishing database version 2, retain and test a compatible recovery
deployment. The old version-1 website cannot open an upgraded profile. Then run
the combined edit/build/run/update/reopen proof, CI and exact hosted-asset
verification. No production browser profiles or hosted assets were changed
during this integration wave.
