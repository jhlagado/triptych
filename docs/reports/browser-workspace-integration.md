# Browser workspace integration

Date: 2026-09-06. Branch: `browser-development-workspace`.
Status: completed and published at runtime revision `0f7f077`. The
[roadmap](../plans/browser-development-workspace.md) records the completed
milestone and proposed follow-up work.

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

The old version-1 website cannot open an upgraded profile; rollback must use
a compatible archive, never downgrade or delete browser storage. Physical-phone
and ESP32 qualification remain separate.

## Release checkpoint

The clean candidate is `0f7f077b982e47811c4cf4325f0a07815df147e6`.
The expanded hosted verifier passed against its local HTTP build in three
disposable profiles: fresh, downloaded-disk reopening and version-1 migration.
It verified all 27 assets, actual browser response bodies, the adventure's
edit/build/win workflow, twelve preserved files across selected NUC installation,
and exact disk and backup reopening. The selected installation reinstalls the
current NUC release; it does not claim an old-to-new compiler-version migration.
A fresh reviewer found no blocking defects in the verifier.

Before publishing the storage migration, the clean local recovery build and
passing same-origin runtime report were retained in
[wasm-0f7f077](https://github.com/jhlagado/triptych/releases/tag/wasm-0f7f077).
An independent worker downloaded the public asset, checked its inventory,
verified its digest and all retained assets, and confirmed one passing rollback
test with no retries or skipped cases.

| Retained local evidence         | Identity                                                           |
| ------------------------------- | ------------------------------------------------------------------ |
| Archive                         | `local-browser-recovery-0f7f077.tar.gz`                            |
| Archive SHA-256                 | `f0c013ad4639f7c79c88d0aa00e3c7b967a09b9fc97e94010e242a5c2b758686` |
| Deployment manifest SHA-256     | `0b6937180a285111a48673ef6f680cd67c01bc9487a1d6b9b91b14eea3865dbf` |
| Clean distribution disk SHA-256 | `890ee54910d745a3e2ebdfb31705cd7b6b6f160199a00e3209deea6f4f34e5ab` |

[Linux CI run 33998498157](https://github.com/jhlagado/triptych/actions/runs/33998498157)
passed and deployed that exact revision. Both the full check's browser run and
the final clean-deployment browser run passed all 48 tests. The retained final
JSON report records zero failed, skipped or flaky tests.

The downloaded CI archive passed byte verification. Its exact served files and
runtime report are also retained in the public release, outside CI's 90-day
artifact lifetime. An independent worker downloaded the public CI archive and
reverified its inventory, digest, manifest, 27 assets and 48-test runtime report.

| Retained CI evidence        | Identity                                                           |
| --------------------------- | ------------------------------------------------------------------ |
| Archive                     | `ci-browser-recovery-0f7f077.tar.gz`                               |
| Archive SHA-256             | `27abd8deac81701236ee748459760928d42478df12eb1390332c47929a796b84` |
| Deployment manifest SHA-256 | `dd004a66c9f5e5d194a1ead7c595c29069acb26c92bef6991d4c63aef3dba70d` |
| WASM SHA-256                | `5a7c3d9791c169c496a75a67904d36c8af983547ac8d45dc1d2b8a9f528bdece` |

The local and CI WASM files have different hashes. An independent binary
comparison localized every differing byte to embedded Cargo source paths and
custom symbol-name crate hashes; the executable code section is identical.
The cause of the symbol-hash differences was not independently established.
All other asset manifest entries match. The archives remain separately
identified; the local build is not substituted for the published CI artifact.

The lead ran `tools/prove-hosted-browser.mjs` against
[the actual public site](https://jhlagado.github.io/triptych/) and the downloaded
CI directory. All 27 hosted assets and observed browser responses matched CI.
The fresh, downloaded-disk and migrated-profile workflows passed. The adventure
disk digest was `3e8ee6c513c4837b09ecb9c7826c04d2a50cdc69f90f27bb48d381a9627132b9`;
the migrated disk was `deff785f3b1dec832f24dacb242887c0472373cc3420cf61c33ffb19d157e921`,
with backup `b95289a279aff874a8a16aa8a76e088ffb1dc8d8b86883701a098524158771db`.
These match the local workflow's complete final images.

The final local rerun exposed another test-readiness race. `EDIT MAIN` matched
the CCP command echo before Edit had started, so find/replace keystrokes were
inserted into the source instead. The trace showed the original declaration
unchanged and extra lines before the source header, explaining error 25 rather
than the intended error 86. Both editor-entry checks now wait for the full
filename and Save/Quit status line. The malformed-source assertion also requires
`sub main(,) fails`, not text that could appear in the replacement prompt.
Ten targeted repetitions and all four nearby browser/native-reopen tests passed.
Independent review confirmed the trace and
that all error, source-map, previous-executable and temporary-file assertions
remain intact. No compiler or browser-runtime change was needed.

The runtime release stays pinned to `wasm-0f7f077`. The completion documentation
and test-readiness corrections do not change the runtime and are qualified
separately from deployment. The retained tag, release CI run and hosted manifest
identify the tested runtime independently of those follow-up commits.

Physical Android/iOS keyboard behavior and ESP32 hardware remain unqualified.
Exact-archive upload is not automated; supported source redeployment requires
temporarily allowing the exact retained tag in the Pages environment, which
currently allows only `main`. Existing browser disks are never silently adapted
to a newer operating system. Development-tool security maintenance remains a
separate follow-up; CI also reports the pinned upload action's Node runtime
deprecation warning, without a failed check.
