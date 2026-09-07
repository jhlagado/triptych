# Integrated two-MiB verification gates

Date: 2026-09-07. The system builder and browser admission changes are integrated
at `ecad98e`, following the captured-source and WASM filesystem changes.
Application activation and release qualification remain incomplete.

`npm run check:two-mib-system` assembles each of the sixteen profiles once into
a fresh temporary capture directory. After the builder suite succeeds, the gate
passes those exact artifacts to the browser API tests, including Chromium.
Missing captures fail; no earlier fixture directory is reused. Captures remain
available at the path printed by the command. Both fixture environment variables
are overridden by this gate.

The integrated run passed nine builder tests and 94 browser tests: 77 synthetic
cases plus seventeen actual-artifact cases, including Chromium n01/n16. Its
capture directory was
`/var/folders/z3/5d423z657d7fm572qd818jd00000gn/T/triptych-two-mib-check-JkTqKg`.
This was a development build, not a clean release.

`npm run check:wasm-two-mib-files` rebuilds the Node WASM binding and runs four
filesystem tests against that exact output. Independent review found that the
initial command inherited an optional isolated-binding override. A deliberately
invalid override reproduced the failure after a successful build. The corrected
wrapper pins the absolute freshly built binding path; all four tests passed with
the same invalid inherited override. Direct test invocation still permits an
explicit isolated binding for review.

Both commands are required by `npm run check`, with all earlier gates retained.
Independent review also checked fresh capture and failure sequencing. The previous
full-run browser failure was a stale native CLI package reference, corrected in
`895e479` and verified by its two focused browser tests. The combined full run,
Linux CI and hosted release remain necessary; these focused results do not prove
tool lifetimes, persistent runtime activation or ESP32 behavior.

The full run at `f2b9c60` passed 606 Vitest tests, all 155 browser tests,
the integrated gates above, native terminal/parity checks, existing eight-MiB
tool arenas and the Nucleus adventure. It stopped at the final Rust gate because
two test assertions did not match the workspace formatting.
`cargo fmt --all` changed only those assertions' whitespace. The subsequent
complete `npm run check:rust` passed, including workspace Clippy, tests and the
release WASM build. The original full invocation remains recorded as a failure;
the next integrated revision requires another complete run.

## Saved runtime and deployed assets

At `863077b`, the combined gate also builds the current Node WASM binding and
passes its absolute path to the saved-runtime tests. Both fixture paths and the
binding override are replaced with the fresh outputs. Nine builder tests and
132 browser/runtime tests passed: 77 browser API cases, seventeen captured
artifact cases, 36 runtime-double cases and two actual WASM cases. The capture
directory was
`/var/folders/z3/5d423z657d7fm572qd818jd00000gn/T/triptych-two-mib-check-vg9JHA`.

The browser build at that revision, with the integration checks uncommitted,
produced 67 assets. The deployment checker passed with the full revision and
`--require-two-mib`, requiring all sixteen profiles. Three Chromium tests passed
against the actual served output: verified n01/n16 assets, rejection of a missing
transitive JavaScript dependency, and rejection of a corrupted n16 bootstrap.
Only the empty test host page was synthetic; the modules and binary assets came
from the browser build. The static test server was closed after the run.

The hosted proof now requires the same profile set and fetches n01/n16 through
the served browser module. Its saved-machine path retains the existing checks
against fetching fresh system bytes. Independent review found no actionable
issues in these changes. These local served tests do not establish the public
site's behavior; the release still requires the hosted proof after publication.

The saved-runtime adapter is integrated and tested but is not yet connected to
the public application's storage and configuration controls. Browser activation,
complete tool qualification and release verification remain open.

## Complete foundation run

The full `npm run check` at `13db997` completed successfully, including all
158 browser cases and the final Rust formatting, Clippy, workspace tests and
release WASM build. This run supersedes the failed `f2b9c60` invocation for the
integrated saved-runtime and deployment-check foundation. Its retained log is
`/tmp/triptych-two-mib-host-smoke.Te931B/saved-runtime-served-assets-full-check.log`.
The matching older Linux run `34073569820` failed on the same two formatting
assertions fixed before this local run; it is not a green CI result.

Subsequent integration adds the reviewed
[two-MiB lifetime matrix](two-mib-tool-lifetimes.md) as a required check after
the historical large-disk gates. It retains the earlier gates and requires the
native/WASM hosts they build. The browser CI timeout is now 45 minutes: the
previous Linux check took about seventeen minutes, and the new 31-case matrix
adds two-worker instruction-level proofs whose combined CI cost remains to be
measured.

At `41fb8a1`, the required wrapper completed all 31 jobs successfully in
928,779 ms with two concurrent proofs. Its fifteen scheduler tests also passed.
The complete local log is
`/tmp/triptych-two-mib-host-smoke.Te931B/integrated-full-lifetime-matrix.log`.
This is the measured combined wrapper cost, rather than the sum of earlier
individual invocation durations. It does not establish the combined Linux CI
duration or replace the complete expanded repository check.

Browser activation is integrated at `5113515`; its
[application report](two-mib-browser-activation.md) records 180 passing packaged
Chromium cases, candidate preparation, independent review and sixteen-media
measurements. The full expanded check and released-site qualification remain
separate requirements.
