# Two-MiB storage backend qualification

Date: 2026-09-07. Scope: isolated browser persistence and native sparse media.
The application still uses its existing save path; the new writer has not been
enabled on the hosted website or used to migrate user media.

## Browser store

`saved-machine-store.js` implements the isolated stores and activation marker
from the [v4 save contract](../specifications/cpm-drive-set-v4.md). It preserves
historical stores, includes a complete predecessor backup on first publication,
and returns an explicit authority token with each publication receipt.

The focused real-Chromium IndexedDB suite passed **62 tests**. It exercises
all sixteen media, sparse A/P, historical v1/v2/v3 predecessors, independent
same-content disks, stale publishers, retries, immutable blobs and backup
retention. Transaction tests inject quota errors, aborts at each publication
stage, asynchronous duplicate-key failure and an abort after request success.
Every failed-publication case compares the complete before/after database state.

The historical-race tests change or delete an old blob during hashing while
leaving its head metadata unchanged. Publication re-reads every referenced blob
inside the write transaction and rejects the changed evidence. Garbage
collection verifies backup digests before its transaction and rechecks the
captured roots before deleting blobs. Damaged or missing backup references
suspend collection rather than authorizing a guess about recoverable data.

Review found two operation-history gaps: malformed receipts were initially
checked only during retry, and positive but impossible revision transitions
were accepted. Loading now validates every operation record, its predecessor
transition and its relationship to the current head. The expanded tests cover
these faults alongside legitimate retries after later checkpoints. A nested
test-registration mistake was also corrected; the final run executed all 62
cases, rather than merely passing JavaScript syntax checks.

This was a lead review plus separate reused-context reviewers, not a fresh
multi-reviewer panel. The tests establish browser transaction behavior under
injected failures, not physical power-loss durability or mobile peak memory.

## Native sparse media

The native host accepts explicit slot configuration:

```text
triptych-host-native --slots 16 --drive A a.img --drive P p.img --image-bytes 2097152 boot.bin
```

The original positional A/B invocation remains supported. Empty slots retain
their indices. Media are opened without truncation, checked by opened-handle
device/inode identity, exclusively locked, then validated before the CPU and
console thread start. A partial attachment failure releases preceding locks.
The optional image-length assertion checks the locked handles; it does not
infer or install a CP/M resident profile.

After integration, `cargo test -p triptych-host-native` passed **15 tests** on
macOS: eight store tests, six CLI tests and the existing fresh-process durability
test. A separate reviewer also executed those isolated test binaries. Cases
include A/P mapping with missing B, alias rejection, independent equal-content
files, concurrent-process exclusion, normal/forced process termination, read-only
ownership and exact-size rejection before guest output.

The native crate now declares Rust 1.89 for its locking API. Tests used the
pinned Rust 1.98 toolchain, so minimum-version compilation remains unmeasured.
Linux execution, including its additional non-UTF8 filename test, requires CI.
The other crates retain their existing minimum-version declaration.

Advisory locks exclude cooperating hosts. Arbitrary editors and path replacement
remain outside that protection. The image-management CLI does not yet implement
the same ownership protocol and must be used offline. An ordinary nonregular
path is rejected before opening; this preflight is not protection against an
adversarial replacement with a FIFO between the check and open.

## Sparse guest integration probe

A disposable n16 machine with only A and P inserted booted in native and WASM
hosts, assembled `TWOTEST.ASM` with ATOM on P, and executed the resulting COM.
Complete console transcripts and both final images matched between hosts. A
remained unchanged; P contained the generated program. B through O stayed empty.

This probe used explicitly supplied local Portable CP/M 0.1.4 artifacts and
Triptych's production BIOS/bootstrap builder. Its sources and result are retained
under `/tmp/triptych-two-mib-host-smoke.Te931B/` as `sparse-smoke.mjs` and
`sparse-STWPjn/results.json`. It is a development integration measurement, not a
release-pin proof, complete ATOM/NUC/Edit arena run or fresh-process reopening
proof for the same saved P image.

## Combined regression gate

The complete `npm run check` passed on macOS with `VITEST_MAX_WORKERS=2`,
using the pinned Rust 1.98 and wasm-bindgen 0.2.127 environment. All 552 Vitest
tests and 153 Chromium tests passed, including the 62 new storage cases.
The remaining commands completed the existing native/WASM parity, eight-MiB
ATOM/NUC/Edit capacity arenas, terminal and adventure proofs, Rust formatting,
Clippy, workspace tests and release WASM build.

Earlier default-worker attempts timed out in existing assertion or assembly
setup paths. The exact byte-array assertion change is measured separately in
[the assertion report](two-mib-assertion-cost.md). A quiet default-worker run
still timed out in one assembly setup hook, so concurrent compiler generation
was not a sufficient explanation. The successful run limited Vitest worker
concurrency; no deadlines, assertions or test cases were removed or relaxed.

The successful log is
`/tmp/triptych-two-mib-host-smoke.Te931B/v4-store-native-two-workers-full-check.log`.
This gate covers the storage/native slice based on parent `75988c7`, before the
separate new workspace coordinator and release-consumer commits are integrated.
Linux qualification of this slice remains pending.

## Remaining integration

Workspace publication, bounded autosaves, runtime profile admission, guarded
reconfiguration, browser controls and actual hosted recovery remain unfinished.
Native image-tool cooperation and full new-layout tool qualification are separate
gates. No result here establishes ESP32 SD caching or power-loss behavior.
