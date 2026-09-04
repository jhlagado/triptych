# Software stability baseline

2026-09-05. Read-only inventory before the cross-project stability work.
The [master roadmap](../plans/software-stability-roadmap.md) defines the goal.
These are local Git observations and source inspections, not new hardware or
published-browser measurements.

## Repositories and preserved work

| Local repository under `/Users/johnhardy/projects/` | Observed revision / state                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `triptych`                                          | `main`, `1ea5d47`; clean before this roadmap and readiness work                                                      |
| `atom`                                              | `main`, `27b32ad`; untracked `.DS_Store` preserved                                                                   |
| `nucleus/.worktrees/main`                           | `main`, `6bd2723`; standalone integration baseline                                                                   |
| `nucleus/.worktrees/atom-reconciliation`            | `reconcile-atom` based on `6bd2723`; unpublished source/generated-image changes preserved                            |
| `nucleus`                                           | `compiler-rewrite-12k`, `562bf79`; modified lockfile and untracked `.DS_Store`, `.worktrees/`, `Untitled/` preserved |
| `debug80`                                           | `main`, `2ad5f5c`; untracked `.worktrees/` preserved                                                                 |
| `debug80-runtime`                                   | `main`, `0024be1`; clean                                                                                             |
| `z80-tool-services`                                 | `main`, `d75f2e0`; clean                                                                                             |
| `z80-workspace`                                     | Local launcher, not a Git repository; integration paused pending reconciled pins                                     |
| `cpm22`                                             | Local directory, not a Git repository; not the authority for Triptych resident software                              |

Nucleus's reconciliation report records 13 adapter/comparison tests, a
23-file/130-test prebuilt-host subset, deterministic ATOM regeneration and
type/distribution checks. Those are retained checkpoint results, not fresh
full-suite results from this audit. Its 33 legacy source-assembly test files
remain outside that checkpoint. The older 556-test baseline must not be
presented as a passing result for the changed tree.

## Concrete work locations

- Triptych's production image assembler is `tools/cpm22-native-image.mjs`;
  it imports AZM and assembles bootstrap, CCP, BDOS and BIOS. The WASM builder
  and native launchers share it. Test assembly also enters through
  `test/support/assemble-z80.ts` and proof scripts.
- CCP acceptance is `test/ccp/fixtures/feature-matrix.json`. Parser/fuzz,
  failure recovery and resident stack are partial. The initial readiness
  checker required the ESP32 row for publication, conflating software release
  with physical qualification.
- CCP SAVE's decimal loop and delete-before-create sequence are in
  `roms/cpu/ccp/ccp.asm`. The overflow and partial-output concerns identified
  during inspection require executable reproductions; they are not yet
  measured failures.
- BDOS direct-call and filesystem proofs live in `test/bdos/`. Its completed
  software roadmap is `docs/plans/atom-bdos-roadmap.md`.
- Edit authority remains Debug80's
  `apps/debug80-vscode/roms/cpm22/editor*.asm[i]`; its test entry is
  `scripts/cpm22/prove-editor.mjs`. The extensive source proof requires an
  AZM sidecar. Triptych's current editor scenario opens and quits; it is not
  full save/search/replace integration proof.
- Browser state and UI are in `crates/triptych-host-wasm/web/`. The browser
  currently replaces its in-memory machine on image selection and has no
  persistent browser disk store. Machine faults also disable disk download.
- `tools/run-cpm22-native.mjs` does not disable terminal software flow control;
  Ctrl-S/Ctrl-Q interception is a source-supported risk requiring PTY proof.
- `.github/workflows/wasm-pages.yml` publishes main/manual builds. PR checks,
  real-browser acceptance and a post-publication smoke need explicit gates.
- `firmware/cpu/src/main.rs` is a serial-only conformance image. SD and physical
  CPU application qualification remain later work.

The browser ANSI model check was freshly run during this audit:
`node tools/check-wasm-browser-ui.mjs` passed. The AZM-dependent full checks
and image builds were not run, in accordance with the user's assembler policy.
Existing Pages evidence is in `atom-ccp-builtins-checkpoint.md`; no live
deployment was fetched in this baseline audit.

## S0 implementation checkpoint

The roadmap and assembler guidance are now recorded. The CPU specification's
obsolete transitional-CCP paragraph now describes the current Triptych
implementation and its remaining acceptance work.

CCP feature-matrix schema v2 separates software `publicationReady` from
`hardwareQualified`. Both remain false. Software publication requires every
software row to be proved; hardware qualification additionally requires
physical ESP32 evidence. Parser, failure-recovery and self-assembly rows are
now explicit required entries in the matrix checker.

The extracted readiness rule initially reproduced the old hardware dependency:
the software-only release test failed, alongside two new hardware-declaration
checks. After the fix, `npm run check:ccp-readiness` passed all seven tests,
including planned/partial status checks for each software row. No existing
feature evidence was promoted.

Fresh verification:

- Type-checking, lint, full formatting check and browser ANSI checks passed.
- `npm run check` was attempted with a temporary Node 24 import guard that
  rejects AZM before its code loads. Build and the preceding checks passed;
  Vitest passed 47 tests in seven files, while four BDOS suites failed to load
  through their AZM-dependent assembly helper. Later full-check stages did
  not execute. This is an incomplete full check, not a BDOS behavior result.
- The new roadmap/report passed the prose gate and sequential read-back.
  `git diff --check` passed. No image was rebuilt or deployed.

The guard is a local diagnostic under `/tmp/triptych-atom-check.Xb9l24/`, not
a new project dependency. S1 must migrate those helpers and run the ordinary
complete checks with ATOM. This checkpoint changed only Triptych; the dirty
Nucleus and other repository worktrees were preserved.
