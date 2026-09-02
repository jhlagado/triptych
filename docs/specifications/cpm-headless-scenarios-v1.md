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

The optional scenario-level `systemBdos` field selects the resident BDOS
installed before the first session. Omission or `oracle` retains the frozen
transitional binary; `triptych` assembles and installs the current
`roms/cpu/bdos/bdos.asm`. This selection is part of test setup, not a service
visible to the guest. Each scenario still pins the digest of the resulting
complete starting image, so changing either implementation cannot silently
reuse stale expectations.

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

The executable examples under `test/bdos/scenarios/` cover a persistent CCP
file round trip and a staged ANSI editor launch/quit. Run every scenario with:

```sh
npm run proof:cpm-headless
```

Set `TRIPTYCH_CPM_SCENARIO` to one fixture path and
`TRIPTYCH_CPM22_IMAGE` to another provenance-reviewed image when required.
