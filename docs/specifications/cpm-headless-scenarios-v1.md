# CP/M headless scenario contract v1

Status: test contract

This contract makes a CCP or CP/M application session reproducible without a
browser, GUI terminal, or ESP32. It treats the serial connection as the
machine boundary: a fixture supplies input bytes, the host runs the unchanged
Triptych CPU model, and the fixture checks both the exact output bytes and the
screen produced by Triptych's ANSI terminal model.

The raw transcript is authoritative for CP/M compatibility. The terminal
snapshot is a second observation of those same bytes, not a service visible to
the guest and not a substitute for checking the transcript.

## Scenario lifecycle

A scenario contains one or more ordered sessions. Each session:

1. constructs a fresh machine and installs a private copy of the current drive
   image;
2. queues the declared serial input;
3. runs bounded instruction slices until the output ends with the declared
   byte sequence;
4. compares the complete serial transcript;
5. feeds the transcript to the DOM-free 80-by-24 terminal model and compares
   its state; and
6. exports the drive image for the following fresh-machine session.

Carrying only the exported image between sessions proves process-independent
disk persistence. RAM, CPU registers, queued input, console output, and
terminal state do not survive a session boundary.

The optional scenario-level `systemCcp` and `systemBdos` fields independently
select the resident implementations installed before the first session.
Omission or `oracle` retains that frozen transitional component; `triptych`
assembles and installs `roms/cpu/ccp/ccp.asm` or
`roms/cpu/bdos/bdos.asm`. These selections are test setup, not services visible
to the guest. Each scenario still pins the digest of the resulting complete
starting image, so changing either implementation cannot silently reuse stale
expectations.

## Fixture shape

The JSON schema identifier is `triptych-cpm-headless-scenario-v1`. A scenario
has an `id`, a human-readable `description`, an
`expectedInitialDriveSha256` identifying the exact installed starting image,
and a non-empty `sessions` array. The runner checks the starting digest before
booting the first machine, so a fixture cannot silently replay against a
different CCP, BDOS, BIOS, or application set. For a one-shot command, each
session has an `id` and exactly one field from each pair below:

| Purpose                  | Readable 7-bit form  | Arbitrary byte form       |
| ------------------------ | -------------------- | ------------------------- |
| queued terminal input    | `inputAscii`         | `inputBytes`              |
| output completion suffix | `stopAfterAscii`     | `stopAfterBytes`          |
| complete raw transcript  | `expectedTranscript` | `expectedTranscriptBytes` |

The byte form is an array of integers from 0 through 255. It is suitable for
control keys, escape sequences, and non-ASCII programs. A completion suffix is
only a deterministic stopping condition; the complete transcript must still
match.

The optional positive `maximumSlices` raises the per-interaction instruction
slice bound for deliberately large compiler inputs. It is still a timeout,
not a performance expectation; ordinary scenarios retain the default bound.

### Private fixture preparation

An optional `initialFiles` array installs repository-owned inputs into the
scenario's private disk before its initial digest is checked. Each entry names
the CP/M file, repository-relative source path, and `cpm-text` encoding. Text
preparation validates ASCII, converts line endings to CRLF, and uses `$1A` for
record padding. The repository file and original transitional disk remain
unchanged.

An optional `initialPrograms` array installs a test-only transient assembled
from repository-owned Atom-compatible source. Each entry has kind
`assemble-atom`, a CP/M destination name, a repository-relative source path,
and the exact expected byte length and SHA-256 of the assembled program. This
is intended for public-boundary probes, not for embedding host implementations
of CCP behavior in fixtures.

An optional `initialTools` array may derive a narrowly configured guest tool
from a provenance-pinned binary already on that private disk. The currently
defined `retarget-cpm22-atom` operation changes Atom's target start, capacity,
and their derived output-adapter words while leaving its assembler core
unchanged. The fixture pins the derived tool's name and SHA-256. This exists so
resident firmware can be assembled at its real address; the ordinary bundled
`ATOM.COM` remains the `$0100` application profile.

An optional `expectedFinalFiles` array names record-padded CP/M files by exact
byte length and SHA-256. This is stronger and more readable than relying only
on a complete disk digest when a compiler or assembler is under test.

An interactive application can replace the session-level input and completion
fields with a non-empty `interactions` array. Each interaction has its own
input and completion pair. The runner waits for one completion boundary before
injecting the next input. This prevents console polling during screen drawing
from consuming a key that a person would not press until the application was
ready. An interaction may carry its own `expectedTerminal` snapshot, allowing
the fixture to prove an editor screen before a later interaction clears it.

`expectedTerminal` contains readable `text`, zero-based `cursorRow` and
`cursorColumn`, `bellCount`, and normally `currentAttributes`, `wrapPending`,
and `screenSha256`. The digest covers every character cell, every attribute
cell, the cursor, current attributes, pending-wrap state, bell count, and
screen dimensions. Keeping readable text alongside the digest makes failures
both exact and understandable.

A session may also contain `expectedDriveSha256`. This checks the complete
exported image after all guest writes reaching the storage flush boundary.

## Host boundary

The reusable runner in `tools/lib/cpm-headless-scenario.mjs` depends on only
five host operations: queue input, run one bounded slice, copy serial output,
export drive zero, and close the machine. The current executable adapter uses
the headless WASM host. A native adapter must consume the same fixtures and
produce the same guest-visible result; it must not create a parallel scenario
format.

The runner and terminal model are development tools. They do not enter the
portable CPU core, firmware, BIOS, BDOS, CCP, or COM programs.

## Scope and acceptance

Scenarios should cover three progressively stronger layers:

- CCP built-ins and command parsing;
- ordinary `.COM` programs, compilers, and generated programs; and
- interactive ANSI applications, including control-key and cursor-key input.

A scenario passes only when the raw transcript, terminal state, and any
declared disk digest all pass. Timeouts and unexpected extra output fail. These
are host-model proofs; they do not measure physical serial reliability,
ESP32-S3 scheduling, or SD-card timing.

## Bundled application qualification

Every CCP or `.COM` application retained in the distributable system image
must have a headless scenario before it is treated as qualified. The scenario
must run the real guest binary through the CPU and serial boundaries; a host
reimplementation of the command or application is not a substitute.

- A line-oriented command must prove its exact serial transcript and any disk
  change it makes.
- A full-screen ANSI application must use staged interactions and prove at
  least one meaningful intermediate screen before its clean exit state.
- A compiler or assembler must pin the resulting disk image, then run or
  otherwise consume its generated artifact in a fresh-machine session. A
  resident-image assembler may instead compare the complete generated file
  byte-for-byte with an independently assembled image when executing that file
  as a transient program would be invalid.

The fixture may describe keystrokes and expected observations, but it must not
contain guest application logic. This keeps the same scenario portable across
the WASM host, the native host, and eventually an ESP32 test adapter.

The executable examples under `test/bdos/scenarios/` and
`test/ccp/scenarios/` cover persistent file workflows, a staged ANSI editor,
and resident-component compatibility probes. Run every scenario with:

```sh
npm run proof:cpm-headless
```

Set `TRIPTYCH_CPM_SCENARIO` to one fixture path and
`TRIPTYCH_CPM22_IMAGE` to another provenance-reviewed image when required.
