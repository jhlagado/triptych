# Browser workspace planning evidence

Date: 2026-09-06. Source baseline:
`04e78c24523781d9012fa3ecd4eb07ec1d70d105`. Working branch:
`browser-development-workspace`.

The [execution plan](../plans/browser-development-workspace.md) is reviewed
and ready for its first implementation stage. This checkpoint changes
documentation only. No browser storage schema, user disk, published website
or production component has changed.

## Parallel investigation and review

Two independent architecture agents inspected the browser persistence,
WASM disk host and Rust filesystem. A separate agent checked the released
Nucleus command and ran a disposable application pilot. One architecture
agent subsequently inspected mobile layout and existing acceptance tests.
The lead inspected the implementation, ran the full repository check and
replayed the application pilot.

Two fresh read-only reviewers then examined the proposed plan. One also
compared both complete design candidates against five criteria: preservation
under storage failure, guest-state safety, reuse of existing components,
small interfaces, and independently testable work.

Candidate B's compact management session was selected. Candidate A supplied
explicit checkpoint acknowledgment, operation-identity recovery and exact
saved-image reconstruction. Both candidates independently identified the
gap between flush-time bytes and the browser's later snapshot, and the
persistence queue's error-reporting versus acknowledgment distinction.
No model diversity was requested or used. Candidate B's first attempt ended
with a capacity error; a resumed attempt completed before comparison.

| Review finding                                                                                                     | Lead judgment and disposition                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Existing whole-image Open could bypass management; a pending file read could complete after controls were disabled | Confirmed from the asynchronous handler. All replacements use the coordinator; stale read completions need a session check.                                  |
| Current Download uses live backing sectors rather than an exact flush checkpoint                                   | Confirmed from the export call and sector-store write path. Committed images, immutable backups and unsaved exact checkpoints are distinct download sources. |
| An old deployment archive cannot reopen a profile after the database version increases                             | Confirmed from the explicit version-1 database open. A tested version-2-compatible recovery build is a publication gate.                                     |

Both reviewers checked the revised plan and reported their findings resolved
at the planning level. There is no remaining design blocker to the safety
pilot. These reviews do not prove the future implementation; storage changes
will receive fresh diff reviews and failure tests.

## Disposable Nucleus pilot

The pilot ran the released `NUC.COM` inside CP/M, rather than compiling through
the Node Nucleus API. Private copies of the retained published WASM artifact
and an existing macOS native executable were used. No compiler or host was
rebuilt for this experiment, and no installed user disk was used.

The compiler accepted a 671-byte, single-source program with Cave and Hill
locations. E and W change location, X leaves the location unchanged, CR and
LF repaint, and Q returns to `A>`. The lead read the scripts and reran both
experiments successfully.

Nine checkpoints matched byte-for-byte between hosts: boot, compile, launch,
east, invalid input, CR, LF, west and quit. The native process exited with
code zero. Complete resulting disk bytes also matched.

| Artifact                       | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| Pilot `GAME.NU`, 671 bytes     | `43a912427f9abf7f16286eadb6fb5fb73ca68cc780a947888acd392792fe4bfe` |
| Initial published disk         | `6f03fe40c4d45f8b8f7ff57949261f5ed5d6f687870d1234af208a3393b1df7e` |
| Resulting disk on both hosts   | `e55dbe77eaeae4a726d7049356d9f8256979dc3742ffa5e8103f597e5892affc` |
| Retained WASM executable       | `23dba2d4766bd5e017193e9f2101ecb077edeb37ed3378036bcd7cb64dd037f5` |
| Copied macOS native executable | `24fae5d250be1dd02ec420815c3618813d0a17f191997a98605e2713ffc78c3e` |

Local scratch evidence is under
`/tmp/triptych-browser-plan.nlKRrH/adventure-pilot/`: `GAME.NU`,
`pilot.mjs`, `native-pilot.mjs`, `RUN.json`, `result.json` and
`native-result.json`. The two commands are `node pilot.mjs` followed by
`node native-pilot.mjs` in that directory. This is a workstation-local
experiment, not yet a portable fixture or distributed application.

Limits: uppercase single-key choices, one source file, no item/win condition,
no save-game feature, and no measured remaining compiler capacity. The
25,600-byte program figure is its record-padded disk content, not isolated
useful code. The experiment does not prove multi-file source compilation,
edit/recompile, failed-build preservation, browser persistence, a physical
phone keyboard or ESP32 behavior.

## Baseline verification

`npm run check` completed with exit code zero on macOS after configuring the
existing pinned tools. It included 275 TypeScript tests, browser acceptance,
CP/M distribution checks, native terminal and native/WASM parity proofs,
Rust format/lint/tests and the release WASM build. This is evidence for the
unchanged runtime baseline, not the planned file-management implementation.

Initial attempts stopped on local tool setup: Rust was absent from the command
path, an older temporary installation had conflicting component metadata and
a missing helper, and the complete installation's default WASM linker lacked
a resolved LLVM library path. The successful check used the existing complete
Rust 1.98.0 installation and existing working linker:

```sh
env CARGO_HOME=/tmp/triptych-cargo \
  RUSTUP_HOME=/tmp/nucleus-triptych-rust.5bPzOi \
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER=/tmp/triptych-rust-lld-1.98.0 \
  PATH=/tmp/nucleus-triptych-rust.5bPzOi/toolchains/1.98.0-aarch64-apple-darwin/bin:/tmp/triptych-wasm-bindgen-0.2.127/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  npm run check
```

These temporary paths document this run; they are not project dependencies or
the recommended fresh-machine installation. No repository toolchain pin was
changed. Documentation formatting and prose checks were also run. CI and
hosted publication are future release gates, not results of this planning
checkpoint.
