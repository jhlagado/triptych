# Two-MiB release qualification

Initial checkpoint: 2026-09-07, with browser release qualification in progress. The
candidate has configurable 1–16 two-MiB slots, with historical small and eight-MiB
media retained. No completed release or ESP32 result is claimed here.

## Guest full-volume proof

Portable CP/M [PR 6](https://github.com/jhlagado/portable-cpm/pull/6) merged at
`19859ea0a0ae6cd5f565679994f3a24323a8115d`. Its test writes all 16,000 records
through BDOS on P, rejects further allocation without changing disk contents,
reconstructs the full allocation vector in a fresh CPU and reads every record.
Deletion and block reuse also pass, with fifteen other media unchanged.

The upstream complete check passed all 403 tests and the release build locally.
[Linux CI](https://github.com/jhlagado/portable-cpm/actions/runs/34081032831)
passed the full check, all resident-profile builds and artifact retention.
The lead and an independent reviewer checked the test and its reused guards.
The [upstream report](https://github.com/jhlagado/portable-cpm/blob/19859ea0a0ae6cd5f565679994f3a24323a8115d/docs/reports/two-mib-full-volume.md)
records exact source and binary hashes, counters and scope.

This merge changes tests and documentation only. Triptych's two-MiB profiles
retain their qualified Portable CP/M 0.1.4 source pin
`d28fc52774c967d1422b3b814d51c069247504c1`.
The unchanged BDOS source and ATOM identity bind the new evidence to that input;
no OS replacement or new artifact version is needed for this proof.

## Expanded local check

The full `npm run check` at `b2e9e2e4c78e9503110a528116e067b323bb3a43`
terminated with status 1. The log records `ENOSPC` while writing retained
images and a result report in the two-MiB lifetime matrix. Both active proof
children closed before the matrix rejected; the run was not restarted while
alive. The failed jobs were n01 Edit and n01 ATOM dependency-chain proofs.

Earlier stages in that invocation passed, including all 180 packaged browser
cases, native/WASM host parity, the integrated native saved-archive gate and
historical eight-MiB checks. The complete invocation is still a failed run;
these partial results do not establish completion of the 31-job matrix or the
later adventure and Rust stages. Its retained log is:

```text
/tmp/triptych-two-mib-host-smoke.Te931B/native-archive-integrated-full-check.b2e9e2e.log
```

To recover local space, 387 content-addressed proof images from this stopped
run and the earlier completed browser-activation run were compressed losslessly.
Each new gzip file was synced, decompressed and hash-checked against its original
image before raw removal. Directory syncs and a synced receipt preceded removal.
A separate pass verified every compressed image and confirmed raw removal.
The 1,239,416,832 raw bytes became 14,856,081 gzip bytes, reclaiming
1,224,560,751 logical bytes. No project sources, user disks or reports were removed.

For the 387 content-addressed image paths listed in the receipt, the exact
contents are retained at the original path plus `.gz`. Decompressing that file
restores the original image and hash. The temporary receipt, compaction utility and log
are under `/tmp/triptych-two-mib-host-smoke.Te931B/`, named
`closed-proof-image-compaction.jsonl`, `compact-closed-proof-images.mjs` and
`closed-proof-image-compaction.log`. This is local evidence retention, not a
published browser recovery archive.

A separate compaction covered 187 content-addressed images from a completed
31-job matrix. Its receipt is `completed-matrix-image-compaction.jsonl` in the
same directory. The 392,167,424 raw bytes became 6,985,378 gzip bytes, reclaiming
385,182,046 logical bytes. These images are also retained at their original
paths plus `.gz`.

After the successful local run, a third pass preserved 171 named native images
from the same three older, terminal runs. Each original now has a verified
`.img.gz` copy; the latest run's images were excluded. The 509,607,936 raw bytes
became 6,499,247 gzip bytes, reclaiming 503,108,689 logical bytes. The receipt is
`closed-native-image-compaction.jsonl` in the same temporary directory, with
SHA-256 `62892e9818fa563629eadf99be2adb8087cfc77a734db26670f5df5f3f4a2831`.
All 171 replacements passed a separate decompression, length and hash check.

The subsequent complete macOS `npm run check` at
`1a44ffc3ed000ef36fd34cd2c8a09aa731a185ed` exited with status 0. It completed
the 31-job tool-lifetime matrix, adventure integration and final Rust checks. Its log
is `/tmp/triptych-two-mib-host-smoke.Te931B/space-recovered-full-check.1a44ffc.log`.
The log SHA-256 is
`620c5c3a863c700245dafab08177ec9fc915e851a9e173189996fc4de9db1d27`.
This later result does not change the failed status of the earlier run.

## Hosted verifier

The reviewed extension is integrated at `6c53ebf`. It adds genuine v3 store
promotion, checks that original stores and complete preceding backups survive,
and exercises sixteen distinct populated media through public browser controls.
A later P edit makes archive restoration observably different from a no-op.
Same-origin recovery serves only retained site files, blocks live fallback and
fresh system/media requests, and compares complete head and backup downloads.

At integration, syntax, formatting and source review had passed; execution
against an exact clean CI artifact was still pending. PR artifacts identify the
tested merge revision; their revision must come from the inspected manifest and ancestry, not an
assumed branch-head hash. The actual deployed main artifact requires its own
hosted run and permanently retained, redownload-verified recovery package.

## Clean CI artifact preview

On 2026-09-07, the expanded verifier passed against the exact recovery artifact
from [Linux run 34080083297](https://github.com/jhlagado/triptych/actions/runs/34080083297),
served at a disposable localhost origin. That run passed its complete checks
and all 180 final browser cases, with no skipped, flaky or unexpected cases.
The tested PR merge revision was `ea6ed7fcc090927114bf2069d4412f76e7d28910`;
the artifact contained 72 assets and all sixteen two-MiB profile descriptors.

The preview passed all eight browser test profiles, including genuine v3
promotion and sixteen populated media with distinct identities and guest
sentinels. Archive restoration followed a real change to P. Same-origin
recovery used only retained site files, with live fallback and fresh-system/media
requests blocked. The head and all three backup downloads matched exactly.

The verifier SHA-256 was
`e835e6cc28f4ffa690640cac875c5f22c85cc7d9481ea27db0ecd747cc27b583`.
The captured preview log SHA-256 was
`9b86ba067db5bddc1b048ead6a8e18b4a879357bf8783943bad4e75f0da080da`;
the log remains at `/tmp/triptych-ci-34080083297.L0FxeV/hosted-preview.log`.
The process exited with status 0, and its disposable browser and server were
closed. This is an exact CI-artifact preview result, not public Pages
qualification or permanent recovery publication. The final deployed main
artifact requires separate hosted and redownload verification.
