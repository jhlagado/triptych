# ATOM final-byte and Nucleus relocation checkpoint

2026-09-05. S1 remains in progress. This checkpoint concerns host software;
it is not a Triptych distribution or hardware qualification.

## Qualified ATOM revision

ATOM commit `7692c2938a3d3fa08112988516d29aff6897a680` is published on the
`range-and-bootstrap` branch of `jhlagado/atom`. Its guarded
`npm run release:check` passed all 366 tests, including offline package
installation, native and CP/M execution, and two-generation self-host equality.
The package census is 397 entries and 2,221,578 unpacked bytes.

The native driver and desktop host now accept an explicit target ending at
`$10000`, so a program can occupy the final byte at `$FFFF`. Native cursors and
symbols remain 16-bit; the host reports the mathematical exclusive end.
Overflow tests check failure without publication. The change adds four code
bytes and no workspace. ATOM's detailed report is
`docs/reports/final-byte-boundary.md` in its own repository.

The tested package archive has SHA-256
`65279e3b9e7c2059031c75b7de3da647dc7a1da89e87c3669adb83b110681c47`.
It was installed offline under a temporary prefix. A development-only import
hook selects that installed package for Nucleus tests; it does not modify the
Nucleus or Triptych release pins.

## Nucleus migration

The reconciliation worktree now routes its remaining relocation test through
the shared ATOM source adapter. The adapter exposes a label-address map
separately from equate values and accepts an explicit target range. All 14
source-adapter tests and TypeScript checking pass.

The test retains origins zero, `$0100`, `$8000`, and the highest origin at which
the complete compiler fits. It checks full-width dispatch pointers, labels,
prefetch selectors and a diagnostic execution at each origin. The top-fitting
case checks the wrapped end label and the physical extent independently.

The old pinned ATOM fails at target-range validation. The first packed-candidate
run assembled all four images, then exposed a test assumption: Intel HEX
decoding preserves record ranges rather than merging adjacent ones. The
coverage assertion now checks contiguous initialized records through the exact
physical end. The corrected focused run passed in 186.14 seconds, including
all relocated label/table assertions, prefetch selectors and diagnostic
executions. Its log is `/tmp/nucleus-atom-relocation-packed-final.log`.
The broader suite started before that assertion correction and remains under
qualification; it is not claimed to pass by this checkpoint.

The obsolete AZM toolchain script and dependency declaration have been removed
from this worktree. The removal is recoverable from Git. ATOM does not perform
AZM's static register-contract analysis; executable register, stack and control
flow checks remain the qualification mechanism. Nucleus's earlier unpublished
reconciliation and separate compiler-rewrite work are preserved.

## Published-pin consumer qualification

The three compiler-output equivalence tests initially exceeded their
30-second limits while rebuilding baselines through emulated ATOM. The
isolated flat case confirmed a timeout rather than an output mismatch. With
180-second wall-clock allowances, all three exact comparisons pass: flat
58.003 seconds, banked 73.249 seconds, and entry-bank-one 72.140 seconds. Their
NOBJ, Intel HEX and D8 assertions and guest execution budgets are unchanged.
The log is `/tmp/nucleus-equivalence-atom-wallclock.log`.

Nucleus's unpublished reconciliation worktree now pins the published ATOM
commit above in its package declaration and lockfile. A separate source
snapshot at `/private/tmp/nucleus-pinned-consumer.wmGpWy` installed the Git
dependencies with a fresh npm cache and no local package override. The first
attempt disabled scripts and omitted required compiled JavaScript; normal
`npm ci` with a second empty cache prepared those files. All 14 adapter tests,
type checking and the runtime-boundary check pass against that installation.
The generated-image check also passes there: all compiler variants, runtime
profiles, runner, resolver and CP/M embedded assets match their checked-in
files exactly. Its log is `/tmp/nucleus-pinned-generated-images-prepared.log`.
Relocation and compiler checks remain in progress against the fresh install.

Nucleus's CI edit removes its historical Debug80/AZM checkout, build and link
steps, and adds the source-adapter tests before the existing release gate.
The workflow has been parsed locally but has not run on GitHub. Existing
unpublished reconciliation changes and the separate compiler rewrite remain
preserved.

## Next gate

Finish Nucleus's full source/manifest suites,
verify generated images and complete the consumer checks against the published
ATOM commit without a development override. Nucleus publication and downstream
pins remain gated on that work.
Triptych retains its existing ATOM pin and BIOS ownership. No Pages, Linux,
mobile-device or ESP32 qualification is claimed here. Triptych's guarded
`npm run check` passed after these roadmap/report updates; the log is
`/tmp/triptych-nucleus-relocation-checkpoint-check.log`.

The complete guarded Triptych check also passed after the published-pin
checkpoint update. Its log is `/tmp/triptych-nucleus-published-pin-check.log`.
Triptych's own dependency pin was not changed for that run.
