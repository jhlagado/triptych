# Two-MiB browser activation

Date: 2026-09-07. The browser application now uses the saved-machine runtime,
workspace and version-four storage authority. These are local development
results; the public site has not been qualified for this change.

## Application and preservation

The Files panel configures 1–16 slots, creates blank media in empty slots and
ejects data media. Configuration changes retain a complete predecessor backup
and cold reboot. The active summary reports configured slots, inserted letters,
resident profile and COM load capacity. The target-count input is initialized on
activation and entry to management, rather than on every control refresh.

The configuration helper captures inputs before asynchronous work, verifies the
selected resident tuple and prepares a private candidate. Existing two-MiB
filesystems and medium identities are preserved; only A's 6,656 resident bytes
are replaced during an explicitly requested configuration change. Historical
files migrate only when the retained contents fit. Ordinary saved-machine
startup installs the saved bootstrap and media without fetching replacement
system bytes. Missing admission metadata stops a two-MiB machine while keeping
its saved archive downloadable.

Version-four storage can contain historical snapshots. Its first historical
checkpoint retains a complete predecessor backup; a subsequent manual import
creates a separate backup. The retained-deployment test initially expected only
one and failed with two. The corrected test checks both recovery points' bytes,
bootstrap, operation identity and revision. No storage code was changed to
reduce backups. The hosted verifier's analogous v1/v2 assertions were corrected
as well.

## Local evidence

The candidate-helper tests passed all 21 cases using actual WASM filesystem
operations and captured n01–n16 system artifacts. They cover every count,
capture before an await, equal-content media independence, historical A/B
migration, non-fitting B rejection and malformed same-format media preservation.

Nine focused Chromium cases passed in 48.0 seconds against the actual packaged
application. They cover retained-deployment recovery, sparse A/P activation,
full sixteen-image preservation, quota failure during reduction, exact archive
restoration, ejection with unchanged capacity, genuine historical v3 authority
and startup independent of optional historical deployment metadata.

The first complete packaged run passed 177 of 178 cases and failed the backup
expectation described above. The corrected full run passed all 180 cases in 3.1
minutes, including the two additional public tests. Both invocations remain
recorded; the earlier failure is not counted as a passing run.

The UI regression was made executable before its fix: the n16 public workflow
failed because the active configuration summary was absent. After the fix, the
focused run checked the 56,576-byte n16 capacity after activation and reload,
and the unchanged 58,368-byte n02 capacity after ejecting B. Two independent
read-only reviewers identified the display gap and cleared its correction. One
also identified the hosted backup assertions; both reviewed the preservation
paths without finding another concrete issue.

The checked development package contains 72 assets. Its manifest identifies
dirty base `9a0169feaf6aa1827f36be20e397aa5387828fbf`; the following hashes bind
the tested uncommitted package rather than treating that base as its full
source:

| Artifact            | SHA-256                                                            |
| ------------------- | ------------------------------------------------------------------ |
| Deployment manifest | `661a232923aba5683b3533d64f052f1b83af0a25d98bafd50450244fec48f5c4` |
| Packaged app.js     | `80f7597fc8be18d7a7d9f9c733f35100863080a360f2666b115acafedaa9ed78` |
| Packaged index.html | `3b187889caadce82bf9df0bf911ecba579c24d7deddf7c33b904557ac34e9f86` |

The retained local logs are under `/tmp/triptych-browser-activation.G92zG1/`:
`packaged-browser-full.log`, `configuration-display-before.log`,
`review-corrected-focused.log` and `review-corrected-full.log`. These temporary
paths are development evidence, not permanent recovery downloads.

## Sixteen-media measurements

The full run used sixteen distinct 2,097,152-byte images, with different
sentinel files on B–P. The downloaded archive was 33,557,883 bytes. An unchanged
checkpoint retained the same 19 stored blobs, including referenced historical
state, rather than creating another copy of each unchanged image.

| Local operation                          | Elapsed time |
| ---------------------------------------- | -----------: |
| Apply complete staged machine and reboot |       429 ms |
| Unchanged checkpoint and Files listing   |       742 ms |
| Archive creation and download            |       372 ms |
| Reload and read metadata                 |       198 ms |
| Complete measured scenario               |     7,061 ms |

These are single-run desktop Chromium measurements, including automation and
interface work. They are not isolated storage benchmarks or latency guarantees.
The sampled `performance.memory.usedJSHeapSize` was 42,100,000 bytes at all
fifteen sampling points. Those coarse JavaScript-heap readings do not establish
peak browser-process memory, total WASM/storage buffers or an ESP32 RAM budget.
The test retains its JSON measurement as a Playwright attachment.

A separate [management-memory measurement](browser-management-memory.md) now
records calibrated renderer RSS samples for three n01 and three n16 runs.
Median sampled management peaks were 260.05 MiB and 584.81 MiB respectively;
raw samples and the exact deployment manifest are retained with the report.
These are desktop process measurements, not true high-water marks or hardware
memory requirements.

## Remaining qualification

The complete `npm run check` passed at `cc037d2`, including all 180 browser cases
and the 31-job tool matrix. Subsequent native-launcher integration requires an
expanded full check, Linux CI, clean release artifacts and actual hosted/recovery
execution. The hosted
verifier now exercises sixteen-slot activation, P file execution, saved reload
without fresh resident fetches and exact v4 archive identities and hashes. That
implementation has been reviewed but has not yet passed on a released site.

The native engine supports sparse A–P paths. The
[saved-archive launcher](native-saved-archive-sessions.md) has passed local
terminal tests and is integrated for complete qualification. Native file writes can reach backing files
before a guest flush; interrupted session files therefore cannot be described as
last-acknowledged checkpoint archives. ESP32 storage timing and power-loss
behavior require hardware measurements.
