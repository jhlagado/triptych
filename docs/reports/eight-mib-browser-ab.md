# Browser A/B integration

Date: 2026-09-07. This is local integration work following `5750a2c`, not a
deployment announcement. The eight-MiB milestone remains open pending remaining
tool-arena proofs and hosted release qualification. The
[drive-set plan](../plans/browser-drive-sets.md) defines the
storage and publication contract.

## Browser operations

The page now uses the complete-set coordinator and version-three store. A saved
set contains exact bootstrap bytes, a declared resident profile, A and optional
B. Reopening a version-three set does not fetch a replacement bootstrap or
rewrite resident bytes. Legacy records remain available through the historical
bootstrap adapter; the old stores are retained.

Files and recovery has an A/B selector. File imports, tool updates, source
bundles and diagnostic mapping use that selected drive. Changing the selector
does not change the guest's current drive. CP/M's `B:` command selects B for
guest commands.

Enabling A/B is explicit: legacy A files are migrated to a fresh eight-MiB image,
or the resident prefix of an existing eight-MiB A is replaced. Publication backs
up the preceding complete set. Blank B contains no operating-system bytes.
Attaching B requires an eight-MiB image; removing B preserves A's bytes and
resident profile. Raw A replacement has an explicit resident-profile selector;
system adaptation remains a separate opt-in operation.

Saved-set and checkpoint-set downloads use the `.tds` archive. Both include the
bootstrap and every attached drive. Saved-set downloads use durable data;
checkpoint-set downloads include each drive's last successful guest flush,
including data not yet persisted after a browser storage failure. Neither
contains unflushed writes or unsaved editor text. Restoring an archive stages
its exact bytes and backs up the preceding set on publication.

## Executed acceptance

The three new Chromium cases pass against the combined local browser build:

- The public A/B workflow migrates legacy A, creates blank B, imports example
  sources and installs ATOM, NUC and Edit on B. It assembles and runs HELLO,
  edits INPUT.NU, compiles it with NUC and runs the result. Full-image comparisons
  prove A unchanged during B work, with B's reserved system area unchanged.
  Complete export, reload, B removal, backup restoration, archive restoration
  and another reload preserve the expected images and bootstrap. Reopening with
  bootstrap downloads blocked performs no such fetch. When WASM loading fails,
  the complete saved archive and separate raw A/B downloads remain exact.
- Two real guest-I/O cases write both drives but flush only one. They cover
  each direction. Live backing contains the dirty opposite-drive write, while
  durable state and downloaded checkpoint archives contain only acknowledged
  data. Whole-machine readiness is false and manual replacement is rejected.
  These use small ATOM-assembled test bootstraps, not the production BIOS.

The five migrated browser suites also pass all 33 cases: file management,
source projects, one-drive migration, deployment recovery and the original
single-drive partial-flush proof. Their legacy test adapters supply the
historical bootstrap only when the store explicitly requires it.

Five further A/B browser cases pass. Corrupt head metadata and a damaged B
payload both fail closed without fetching a seed disk. Raw A, B, bootstrap and
manifest downloads preserve the exact stored data, and an unaffected preceding
complete-set backup remains downloadable. Delayed tool, file and whole-image
requests started on A cannot stage changes after selection switches to B; a
subsequent explicit B import produces the independently calculated full image.

## Independent review

Reviewers checked components they did not implement, within the existing task
contexts. Their findings produced three fixes:

- A delayed storage refresh could replace a newer acknowledged cache entry.
  Generation checks prevent stale saved-state and recovery results from
  changing the displayed/downloadable state.
- Closing the coordinator could return a pause error before an active save
  finished. Closing now drains publication before reporting that error.
- A delayed backup download could use a newly selected drive instead of the
  drive selected at click time. The handler now captures the selection before
  reading the backup.

Six actual-source application tests and 40 coordinator tests pass. The cache
and close regressions failed before their fixes; an independent delayed-read
probe reproduced the backup-selection fault. The verified deployment/profile
suites pass 106 cases. These counts describe focused checks, not a substitute
for the complete repository command.

## Storage measurements

The optional `tools/measure-browser-drive-sets.mjs` harness uses a private
Chromium context, synthetic media and the actual coordinator/store modules.
It creates and removes its own databases and writer leases. The
[raw samples and environment](eight-mib-browser-storage-measurements.json)
record Chromium 151.0.7922.34 on an Apple M2, with five fixed-order samples per
profile and the median absolute deviation (MAD).

| Profile       | Save median / MAD | Manual change median / MAD |
| ------------- | ----------------- | -------------------------- |
| Legacy A      | 1.8 / 0.3 ms      | 9.3 / 0.3 ms               |
| Eight-MiB A   | 32.4 / 0.5 ms     | 249.9 / 1.5 ms             |
| Eight-MiB A/B | 118.1 / 1.3 ms    | 503.0 / 15.5 ms            |

Save timing includes coordinator copying and hashing through IndexedDB
completion. Manual timing includes management entry and publication but uses
controlled runtime hooks, excluding CPU preparation. The synthetic page runs
no guest, terminal rendering or filesystem parsing. These samples establish a
desktop baseline, not a latency guarantee for other devices or browsers.

Five B-only manual changes add exactly 41,943,040 bytes to stored image payload.
The final eight blobs occupy 58,720,512 payload bytes: one A, six versions of B
and one bootstrap. Six independent complete-set copies would contain
100,664,832 payload bytes. Both counts exclude IndexedDB metadata and engine
overhead; neither is a quota or physical-disk measurement.

A separate queue probe stalls the first save before it enters the store and
submits 100 checkpoints. In all three profiles, 98 pending submissions are
superseded; only the first and last publish. Forced-GC Chromium backing-storage
samples increase by exactly two snapshot payloads. The A/B increase is
33,554,944 bytes. This measures retained coordinator data under that controlled
stall, not transient allocation churn or peak memory during hashing, IndexedDB,
CPU execution or full-page operations. Independent review checked the raw
growth arithmetic and module hashes against the inspected static source.

## Remaining qualification

The complete local `npm run check` passed: 459 code tests in 26 files, 90
Chromium browser cases, the actual 34-scenario/39-session headless replay,
native terminal proofs, native/WASM full-image workflow and capacity comparisons,
and Rust formatting, Clippy, workspace tests and release WASM build. The retained
A/B capacity run passed 19 checkpoints and 14 observed COM lifetimes. Its
declared compiler-table, generated-program arena and recursive-stack exclusions
remain open; they are not covered by padding source files to their size limit.

The current recovery-archive receipt identifies `triptych-drive-set-v3`.
Eighteen archive tests cover current two-profile assets, no-clobber publication,
hash and slot checks, and reserved padding. Older deployment archives require
their corresponding release verifier; this does not change the runtime's
version-one/two saved-disk and backup adapters.

The previous committed Linux run passed `npm run check`, but its separate
headless replay failed on a whole-image expected hash after the pinned BDOS
update. The replay fixtures are now qualified against that update. Historical
BDOS bytes from `bb0b083` reproduced all 34 old scenarios; replacing only the
immutable resident slot predicted the new initial and final images for ordinary
scenarios. The self-assembly case additionally installs the verified new source
and predicts its generated binary from the pinned release. The unchanged runner
then passed all 34 scenarios and 39 sessions.

Only 68 whole-image digest fields in 32 scenarios changed. Transcripts, terminal
states, file hashes and execution limits are unchanged. Some filenames begin
with `oracle-` because their CCP is historical; the affected scenarios explicitly
select Triptych BDOS. Scenarios using historical BDOS remain unchanged. The
default BDOS digest changed from
`c5fc4d7dd29bf8914c4735165747e3b35dca3b8999a9f70035d972ff602718fc`
to `02956431e3af849d99eecbffbb89a0c7a29487f91301575d1dd511127ab4d43b`.
The actual headless replay is now included in `check:cpm-headless`, and therefore
in `npm run check`, so future release-pin drift is checked there too.

The current integration still requires remaining tool-arena qualification,
Linux CI for the new revision, and same-origin hosted recovery qualification.
Source-level queue bounds are not a browser peak-memory
measurement. No physical ESP32 result follows from these host tests.

## Subsequent recovery qualification

The [tool-arena checkpoint](eight-mib-tool-arenas.md) passed the complete local
check and was committed as `3502bed`. The earlier browser checkpoint `729f0d4`
also passed clean Linux browser CI, including 90 final-release browser cases
with no failures, skipped cases or retries reported as flaky. This is CI
qualification, not deployment to the public website.

The downloaded recovery artifact from
[run 34058900462](https://github.com/jhlagado/triptych/actions/runs/34058900462)
identifies GitHub's tested PR merge revision
`d41a6ccb516ac7dd5c33c88985ae3db768ce843b`, not the branch-head revision. Its
33 assets passed the archive verifier with deployment-manifest SHA-256
`ce5bf539f1d42ab39f9c827fd1239b66b1e31be36a5aa202081a89766f9d9194`
and intended schema `triptych-drive-set-v3`.

The updated hosted verifier passed against a local HTTP preview of those exact
CI files in six disposable profiles. It retains the original tool/adventure
workflows and checks version-one and version-two stored-media preservation,
backed-up A/B migration, B tool installation and development, complete backup
download/restoration, and `.tds` import into a separate profile. Each saved
version-three reload rejects fresh disk, configuration, bootstrap and system
downloads. All hosted asset downloads and the browser responses used by these
workflows are checked against CI, including the historical store module used to
prepare the version-two fixture.

The two retained-deployment tests also pass. The new A/B case creates distinct
files on A and B and two complete backups, then reloads at the same origin
using only the retained archive. It blocks live-network fallback and rejects
seed/bootstrap/system requests. Guest reads distinguish both drives, while
complete `.tds` downloads of the head and both backups match their pre-reload
bytes exactly. The CI-artifact override qualifies the new case against the
identified clean build; the original single-A case still runs against the
ordinary local test build.

Independent review corrected a repeated-filename import-completion race in the
test and tightened the verifier's per-navigation and executed-response checks.
No production browser behavior changed in this qualification slice. Actual
GitHub-hosted acceptance, final-revision Linux CI and permanent release/recovery
artifacts remain required before the milestone is complete.
