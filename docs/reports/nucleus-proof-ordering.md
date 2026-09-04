# Nucleus proof ordering checkpoint

2026-09-05. S1 remains in progress. Nucleus's changes remain in its unpublished
`reconcile-atom` worktree; this checkpoint does not update a Triptych component
pin or release a new browser image.

The earlier broad Nucleus run finished with 540 passes and 23 failures across
57 test files. The failures were 18 host timeouts, three descending/overlapping
image layouts, one forward-expression adaptation and one HEX record-range
assertion. Some corrections were made while that diagnostic run continued;
it is not a release-snapshot proof.

All three offending layouts now pass their focused execution proofs. The
structured-control fixture remains at `$9800` but is emitted after the lower
runtime and proof code. Stage 7's `$B000` fixtures also follow the lower code,
and its parameter-capacity fixture now follows the preceding data instead of
reusing `$B000`. Stage 8's runtime block is emitted before its higher fixtures.
Compiler and runtime placements are unchanged; Stage 7's parameter fixture
address intentionally changes.

The three cases retain their expected compiler-core sizes, workspace sizes,
runtime sizes, instruction counts and cycle counts. New assertions check
fixture placement and non-overlap. Only assembly order and the overlapping
fixture address changed; source strings and instruction statements are intact.

Host deadlines now allow time for emulated ATOM assembly. Guest execution and
memory limits and exact-output assertions are unchanged. The combined Stage
7/NOBJ run passes all 13 tests. The complete corrected manifest run passes all
24 tests in 944.72 seconds, including every large compiler layout and the
direct-Z80 semantic proofs. Their logs are
`/tmp/nucleus-manifest-corrected.log` and
`/tmp/nucleus-stage7-nobj-corrected.log`. Details and measurements are in
Nucleus's `docs/reports/atom-proof-ordering.md`.

The installed-package check also passes. It packs the current Nucleus output,
installs it in an isolated consumer without ATOM or AZM, imports every public
export, and compiles and runs a byte-echo program through the library and
command-line interfaces. A rejected second build leaves the preceding object
intact. The checked archive has 234 files and 3,861,114 unpacked bytes; it is
an unpublished worktree artifact rather than a release.

A new candidate snapshot at `/private/tmp/nucleus-release-candidate.3sVlJd`
has installed the pinned Git dependency with an empty cache and no package
override. All 15 adapter tests pass there. Its former complete release gate
passes: deterministic image checks, type checking, 563 tests across 57 files,
the distribution build and runtime-boundary check. The test suite took 1,684.82
seconds; the log is `/tmp/nucleus-release-candidate-gate.log`.

Triptych now pins ATOM revision
`802b5c2d320bec777f427755ff2d7338e3b80a05`. A clean install from an empty npm
cache imports ATOM and its independently installed Z80 tool services without
AZM. The complete guarded `npm run check` then passes with 175 TypeScript tests
across 14 files, the component-lock and WASM working-disk proofs, all native
Rust tests and the release WASM build. Its log is
`/tmp/triptych-final-atom-check.log`.

Next: finish the expanded release gate in the final Nucleus worktree, then
qualify Nucleus publication and downstream updates. BIOS remains
Triptych-owned. No new Linux, Pages, mobile device or ESP32 result is claimed
here.
