# Atom BDOS Milestone 2 report

Status: complete in host models

Date: 2026-09-02

## Result

Triptych now has an original Atom-compatible BDOS implementation at
`roms/cpu/bdos/bdos.asm`. It implements the public `$EC06` entry, functions 0
through 12, unsupported-function rejection, and all private state and stack
storage within `$EC00..$F9FF`.

The retained CCP cold-boots with this replacement and reaches `A>`. A directly
loaded COM-shaped transient prints through BDOS function 9, transfers through
the BIOS warm-boot entry, reloads the system, and returns to the CCP prompt.
These are host-model results, not ESP32-S3 serial or timing measurements.

## Selected shape

The caller-facing form remains conventional CP/M:

```text
C = function, E or DE = parameter, CALL $0005
                      |
                      v
                  JP $EC06
                      |
        save caller SP; use resident private stack
                      |
             dense 0..12 dispatch table
                      |
          BDOS console policy and line editor
                      |
                      v
          public BIOS entries at $FA00
```

Console lookahead, output column, printer-echo state, line-editor cursors, the
saved caller stack pointer, and the private stack are owned by BDOS. BIOS owns
raw console transport. The browser and headless ANSI terminal consume emitted
serial bytes afterward and remain invisible to the guest.

A dense address table won over a comparison chain because the implemented
function numbers are contiguous and the table extends naturally as disk calls
arrive. A single source file won for this first slice because Atom `%INCLUDE`
and AZM `.include` have different ownership semantics; splitting before a
stable disk subsystem boundary would add build policy without hiding useful
complexity. Host-side terminal services and direct port I/O were rejected
because either would couple BDOS to one host and bypass the replaceable BIOS.

## Console contract

The replacement matches reviewed oracle observations for:

- ordinary, direct, reader, punch, and list I/O;
- function 11 lookahead followed by function 1 consumption and echo;
- tab expansion, Ctrl-S pause/resume, and Ctrl-P printer echo;
- buffered input termination by return, line feed, or capacity;
- backspace, rubout, Ctrl-E, Ctrl-R, Ctrl-U, and Ctrl-X editing; and
- Ctrl-C caret echo followed by warm boot at the beginning of a line.

The exact BIOS entry sequence and character bytes remain fixture data rather
than implementation addresses.

## Size and stack

Standalone Atom 0.2.0 and AZM 0.4.0 produced byte-identical 3,584-byte linked
images with SHA-256
`cb1ed4ca8e61150f7d760954a173f3fbf261e86e714299ac90082f2a10bf5051`.
The image is padded to the fixed BDOS slot. Its measured layout is:

| Region                              | Range          | Bytes |
| ----------------------------------- | -------------- | ----: |
| Code, tables, and mutable variables | `$EC00..$EEAB` |   684 |
| Reserved private stack              | `$EEAC..$EEEB` |    64 |
| Free fixed-slot capacity            | `$EEEC..$F9FF` | 2,836 |

The deepest observed stack use across every Milestone 2 direct and stateful
fixture is 12 bytes. The test rejects any descent below the reserved stack
base. This is measured emulator behavior for the current fixtures, not a claim
about unimplemented disk paths.

## Proofs

`test/bdos/direct-call.test.ts` assembles the replacement and runs every
function 0-through-12 fixture against both the frozen oracle and Triptych code.
It also runs the console and I/O-byte stateful sequences against both images.
The focused direct suite contains 72 passing checks after its stack assertion.

`test/bdos/console-program.test.ts` installs the new BDOS and Triptych BIOS in
the complete system image, cold-boots the CPU profile, directly loads
`test/bdos/programs/console-smoke.asm` at `$0100`, and verifies
`TRIPTYCH BDOS\r\n\r\nA>` after warm boot.

`test/bdos/scenarios/triptych-bdos-console-boot.json` selects the current
Triptych BDOS in the reusable headless WASM scenario runner. It pins the full
starting disk digest, raw four-byte `\r\nA>` transcript, disk digest, and the
80-by-24 ANSI screen digest. Oracle scenarios continue to select the frozen
BDOS, so the two implementations can coexist during the staged rewrite.

The standalone Atom comparison is a local development proof because the
published Atom 0.2.0 package's optional AZM peer range does not include the
repository's AZM 0.4.0. CI assembles the common source with AZM; final roadmap
acceptance still requires assembly by `ATOM.COM` inside CP/M.

## Next milestone

Milestone 3 adds BIOS-supplied disk discovery and the read path. Its first
implementation unit is functions 13, 14, 25, 26, 31, and 32: reset/select,
current drive, DMA, DPB address, and user state. The verification predicate is
that the replacement passes `disk-state-roundtrip.json` without embedding the
current IBM 3740 geometry.
