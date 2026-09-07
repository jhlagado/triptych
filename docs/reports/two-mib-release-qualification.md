# Two-MiB release qualification

Date: 2026-09-07. Browser release qualification remains in progress. The current
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

This merge changes tests and documentation only. Triptych retains its qualified
Portable CP/M 0.1.4 source pin `d28fc52774c967d1422b3b814d51c069247504c1`.
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

For these captured proofs, an image path ending in `.img` now has its exact
contents retained at the same path plus `.gz`. Decompressing that file restores
the original image and hash. The temporary receipt, compaction utility and log
are under `/tmp/triptych-two-mib-host-smoke.Te931B/`, named
`closed-proof-image-compaction.jsonl`, `compact-closed-proof-images.mjs` and
`closed-proof-image-compaction.log`. This is local evidence retention, not a
published browser recovery archive.

## Hosted verifier

The reviewed extension is integrated at `6c53ebf`. It adds genuine v3 store
promotion, checks that original stores and complete preceding backups survive,
and exercises sixteen distinct populated media through public browser controls.
A later P edit makes archive restoration observably different from a no-op.
Same-origin recovery serves only retained site files, blocks live fallback and
fresh system/media requests, and compares complete head and backup downloads.

Syntax, formatting and source review passed. Execution against an exact clean
CI artifact remains required. PR artifacts identify the tested merge revision;
their revision must come from the inspected manifest and ancestry, not an
assumed branch-head hash. The actual deployed main artifact requires its own
hosted run and permanently retained, redownload-verified recovery package.
