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

At the earlier `d975cae` integration checkpoint, the lead's complete
`npm run check` passed: 43 actual browser
tests, 274 TypeScript/JavaScript tests, the 28 coordinator and 10 catalog Node
tests, CP/M/ATOM proofs, native terminal and cross-host parity, Rust formatting,
lint and workspace tests, and the WASM release build. The deployment checker
also verified all 23 emitted assets in the local dirty development build.
Documentation formatting was checked again after the report update.

## Released CCP and permanent application proof

Portable CP/M v0.1.1 is published at commit
`b07dad632e7ef3be6528289a5a35308983964b05`. Its 278 tests passed locally and Linux
CI run `33996896372` passed. The release artifacts were downloaded from that CI
run, published unchanged, downloaded again and compared byte-for-byte. Triptych
now consumes them with updated lock and provenance records. The source snapshots
were copied from the immutable upstream commit; ATOM assembly matches the
downloaded binaries. BDOS bytes are unchanged. The raw manifest SHA-256 is
`c94b77512a61855deba8e49da96d0fc0596f2bc0032a124516a942a783042824`.

An independent worker refreshed 47 measured hashes in 21 replacement-CCP
scenarios and the feature matrix. All 21 fixtures then passed through the
unmodified headless runner with their transcript, terminal and file assertions
intact. Oracle scenarios were untouched. Capture images and before/after values
are retained in `/tmp/triptych-ccp-fixtures.DaFKR9/`.

Before permanent application integration, a worker's
private prototype maintained `IO.NU` and `MAIN.NU` separately, then generated a
689-byte `GAME.NU` for the released single-input CP/M compiler. The lead reran
the proof: actual NUC 0.3.1 compiled the bundle in WASM with the corrected CCP;
the game started, moved east/west and quit. A deliberate syntax error mapped
from bundle offset 230 to `MAIN.NU` offset 28, line 2, column 10, matching the
released Node multipart diagnostic. The preceding executable survived.

Evidence is in `/tmp/triptych-multipart-pilot.hUZvdy/pilot.mjs` and `result.json`.
The generated source SHA-256 is
`154a230a351179959cbb35115859b10eef512c7220c4ad442b545eccf10cb7ae`.
That prototype informed the implemented `source-bundle.js` helper and the
original `samples/nucleus-adventure/` starter. The starter maintains `IO.NU`
and `MAIN.NU` separately; `BUILD.JSN` declares their order. Prepare build stages
generated `GAME.NU` and `GAME.MAP` together through the disk coordinator.
There is no CP/M import resolver or compiler change. Ten Node tests cover
padding, CRLF, literal/delimiter boundaries, copied inputs and stale maps.

Two reviewers independently found compiler-output filename collisions and
asynchronous stale diagnostic results. Both were reproduced by browser tests
before correction. Project validation now protects NUC's derived `.COM`,
`.$$$` and `.BAK` names, and diagnostic publication checks the request, panel,
project and exact current snapshot. Fix readback found no remaining issues.

The permanent `tools/prove-nucleus-adventure.mjs` uses the product bundler,
current distribution and actual NUC/Edit. Thirty-one checkpoints and three
complete final disks match between WASM and native macOS. It covers winning,
quitting, invalid input, CR/LF, real Edit replacement, repackaging, rebuilding
and a failed compile. Error 86 maps to `MAIN.NU`, offset 130, line 3, column 10.
The complete failed-build disk is unchanged and the previous game remains
runnable. This proof is wired into `npm run check` after both host builds.

Four new browser tests pass, including the complete starter/import/prepare/
compile/win/Edit/rebuild/selected-NUC-update/reload/download workflow. Sources,
map, executable and unselected tools are compared across the update. The
download reopens in another browser profile and the native host. A separate
actual-Edit syntax-error test proves diagnostic mapping and preservation of
the prior executable; naming and stale-result regressions also pass.

## Recovery deployment and remaining publication gates

The archive helper retains exact served assets and an external identity receipt.
Its nine tests pass; independent review found no actionable defects. Its receipt
explicitly does not claim runtime qualification. The separate browser rollback
test seeds a version-1 disk, migrates it, adds a file and backup, then serves all
HTTP assets from the retained directory at the same origin. Saved revision,
complete disk and backups match; the guest reads the retained user file, and
the distribution image is never fetched over the saved disk. That test passes.

The Pages workflow now retains a clean recovery deployment and the final browser
acceptance report before allowing deployment. CI artifact retention is 90 days;
the release handoff must also retain a durable copy and record its identity.

The combined local `npm run check` passed on 2026-09-06: 48 browser tests,
287 TypeScript/JavaScript tests, 48 coordinator/catalog/bundler Node tests,
the CP/M/ATOM proofs, native terminal and cross-host parity, permanent adventure
replay, Rust formatting, lint and workspace tests, and the WASM release build.
The complete headless CP/M scenario replay also passed separately.

One combined-run failure was a test-readiness race: Playwright's file setter
selected a file before asynchronous management entry enabled the input. An
enabled-input assertion corrected the test; all disk and backup comparisons
were preserved. Ten targeted repetitions and the subsequent complete check
passed. A fresh independent reviewer confirmed the readiness boundary and
archive-only same-origin proof. No product change was needed for that failure.

The [recovery guide](../browser-recovery.md) distinguishes disk restoration,
source redeployment and exact-archive restoration. Source redeployment uses
the normal checked Pages workflow. Exact-archive upload is not automated.

Triptych's clean-release build, CI, durable recovery archive and hosted-asset
verification remain release gates. The old version-1 website cannot open an
upgraded profile; rollback must use a compatible archive, never downgrade or
delete browser storage. Triptych's hosted assets and production browser profiles
remain unchanged so far. Physical-phone and ESP32 qualification remain separate.
