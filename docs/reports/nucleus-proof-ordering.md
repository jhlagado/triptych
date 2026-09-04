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
7/NOBJ run passes all 13 tests; the complete corrected manifest run remains in
progress. Their logs
are `/tmp/nucleus-manifest-corrected.log` and
`/tmp/nucleus-stage7-nobj-corrected.log`. Details and measurements are in
Nucleus's `docs/reports/atom-proof-ordering.md`.

A new candidate snapshot at `/private/tmp/nucleus-release-candidate.3sVlJd`
has installed the pinned Git dependency with an empty cache and no package
override. All 15 adapter tests pass there. Its complete release gate is running;
the log is `/tmp/nucleus-release-candidate-gate.log`.

Triptych's complete guarded `npm run check` passes; its log is
`/tmp/triptych-proof-ordering-check.log`. Next: collect the manifest and clean
release results, then qualify Nucleus publication and downstream updates.
BIOS remains Triptych-owned. No new Linux, Pages, mobile device or ESP32 result
is claimed here.
