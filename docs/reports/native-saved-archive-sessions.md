# Native saved-archive verification

Date: 2026-09-07. These are local macOS results from an isolated development
worktree, integrated at `58503a9`. The expanded full repository gate, Linux
execution and release qualification remain pending.

The copy-only launcher described in the
[native archive plan](../plans/native-saved-archives.md) opened an actual
browser-exported sixteen-drive archive. Both real-CPU tests booted CP/M,
executed `TYPE P:WHO.TXT` and returned `Drive P`. Ctrl-C produced exit status 130;
SIGTERM produced 143. The complete terminal configuration was restored in both
cases, excluding only Darwin's buffered-input status bit `PENDIN`.

Three controlled executables separately exercised normal exit, host exit status
7 and failure to spawn. The launcher returned 0, 1 and 1 respectively, restoring
the terminal in every case. These cases test process handling, not Z80 execution.

Each of the five sessions retained the exact original archive, bootstrap and
all sixteen disk images. Per-session disk files had distinct filesystem inodes.
An independent reviewer checked all eighty image hashes, the retained archives,
bootstrap files and executable/source hashes against the report. These read-only
guest sessions do not establish native write durability or guest access to every
drive. Session files remain raw recovery data, not last-flush checkpoints.

## Retained evidence

The actual browser archive came from the complete sixteen-drive browser test:

```text
/tmp/triptych-browser-activation.G92zG1/results/two-mib-activation-all-six-1a1e3-hive-and-rejected-reduction/all-sixteen.tds
```

The successful native proof, its transcripts, frozen host and five session
directories remain under:

```text
/tmp/triptych-native-archive.vcpYyu/pty-proof-2/
```

`proof-report.json` records exact paths, per-image hashes, terminal settings and
case scopes. The archive SHA-256 is
`4bbcdb86d22df3d4d799d5aba4c0de0a2d821241e934f44ee3c76e3602066fbf`.
The frozen native executable SHA-256 is
`df5d6782e8a60504b46b8bf58014839935a8f448b976bdc93102b6074d81c37b`.
Temporary local paths are evidence locations, not published recovery artifacts.

The first proof attempt booted and read P but encountered an EOF-draining loop
in the Python harness after the host had exited. Its partial evidence remains
under `pty-proof-1`. Correcting the harness to stop at EOF produced the successful
second run; neither the launcher nor the archive preparer changed for that fix.

## Preparation and command-line checks

Eleven Node tests passed before the terminal proof. They cover all sixteen
configured counts with real captured profile descriptors, sparse A/P insertion,
independent files with identical contents, historical small/eight-MiB archives,
malformed input and unavailable metadata, exclusive destinations, partial writes,
source changes during capture and strict command-line parsing.

The command-line symlink test initially failed because the entry-point check
compared a symlink path with the module's resolved URL. Resolving the invoked
path fixed both direct and symlink invocation. A separate failing-before test
established that optional deployment metadata must be read only for archives
requiring two-MiB admission. Historical archives now bypass that optional read;
an explicitly supplied unreadable metadata file still produces an error.

The review used the lead and a reused independent reviewer for the helper and
launcher, then that reviewer checked the separately authored terminal proof.
The review found no unresolved actionable issues after those corrections.

Before integration, a further file-capture test failed because the helper read
the complete input before rejecting an oversized v4 archive. Capture now checks
the exact eight-byte version prefix first, rejects v4 files above 33,620,236
bytes and uses positional reads bounded by the initially observed size. Source
growth or truncation still fails the capture. The v3 size domain is unchanged.
A high-bit prefix test also failed with Node's ASCII decoding; byte-preserving
Latin-1 decoding fixed the preflight comparison. Both focused tests then passed.

Independent review then identified that one header read can legally return fewer
than eight bytes. The new three-byte-chunk test failed on that valid input.
A positional header loop fixed the failure while preserving the v3 file offset;
the same test also verifies rejection of a truncated header. Review cleared the
correction, and the complete gate below passed all fourteen tests.

The actual browser-archive proof was repeated with that final helper. All five
cases passed again; its report and exact retained sessions are in
`/tmp/triptych-native-archive.vcpYyu/pty-proof-4/`. The earlier evidence remains
available and is not attributed to the revised helper.

## Repeatable repository gate

`npm run check:native-saved-machine` runs after the native/WASM build and parity
checks in `npm run check`. It constructs fresh n01–n16 tuples through ATOM,
overrides inherited fixture paths and runs the fourteen Node tests. It then uses
the current checkout's WASM filesystem API to construct sixteen distinct media,
with a `WHO.TXT` sentinel on each, and invokes the terminal proof with that
checkout's native executable. Missing artifacts or any failed step stop the gate.

The complete isolated invocation passed all fourteen tests and five terminal
cases. Its generated archive is explicitly distinguished from the actual
browser export above. Captured tuples, test output and terminal reports remain
under:

```text
/var/folders/z3/5d423z657d7fm572qd818jd00000gn/T/triptych-native-saved-check-Zx2Eey
```

The missing-native-artifact check failed before assembly as required; its
failure report remains in the sibling `triptych-native-saved-check-xo5Gkz`
directory. For focused preparation tests, direct invocation without `--terminal`
requires no WASM or native build. The required repository command always selects
terminal mode. Independent read-only review cleared the gate's fresh-fixture,
failure sequencing and explicit artifact-selection behavior.

## Linux release budget

GitHub run `34075998924`, at `41fb8a1`, exceeded its 45-minute job limit. The
required `Verify Triptych` step passed between 02:23:45 and 03:00:50 UTC, followed
by successful headless replay, browser build and exact release-file checks.
Cancellation occurred during the final release browser step; recovery upload
and deployment did not run. This is not a green release result.

The workflow budget is increased to 75 minutes to accommodate the measured
37-minute verification step plus setup, final browser tests and artifact
retention. No test or release check is removed. The complete workflow still
requires a successful run on the integrated revision.
