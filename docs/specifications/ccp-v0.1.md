# Triptych CP/M 2.2 CCP v0.1 contract

Status: draft replacement contract

Date: 2026-09-03

## Purpose and authority

This document defines the observable boundary of Triptych's Console Command
Processor. It specifies compatibility, not algorithms. The implementation is
original Atom-compatible Z80 assembly and is not a translation of a legacy CCP
source.

The authority order is:

1. the documented CP/M 2.2 command and transient-program interfaces;
2. this Triptych contract for fixed addresses and deterministic choices;
3. manual-derived fixtures;
4. black-box observations from the frozen transitional CCP; and
5. the Triptych implementation.

The frozen oracle is the 2,048-byte CCP with SHA-256
`67fda0f138c3654a2fb15ae49acb2e663c848774779fa9822eda0f6d3a9b8da3`.
Oracle observations record inputs and public results; legacy implementation
source, symbols, control flow, data layout, and instruction sequences are not
inputs to production code.

## Resident and service boundary

| Region or entry   | Range or address | Contract                                      |
| ----------------- | ---------------: | --------------------------------------------- |
| Warm boot         |          `$0000` | BIOS-installed jump                           |
| Current drive     |          `$0004` | zero-based prompt and default-drive value     |
| BDOS entry        |          `$0005` | CCP's only operating-system service boundary  |
| Default FCB 1     |          `$005C` | first transient argument                      |
| Default FCB 2     |          `$006C` | second transient argument                     |
| Command tail      |          `$0080` | length followed by uppercase tail bytes       |
| Transient program |   `$0100..$E3FF` | load and execution area                       |
| CCP               |   `$E400..$EBFF` | code, immutable data, workspace, and stack    |
| BDOS              |   `$EC00..$F9FF` | public dependency; private layout unavailable |

The resident image is exactly 2,048 bytes. It owns no page-zero byte except
while publishing documented transient state. It calls BDOS through `$0005`
and does not call BIOS, Triptych ports, a host filesystem, or host UI APIs.
It is single-tasked and non-reentrant.

Cold and warm boot enter `$E400` with `C` containing the current drive. CCP
reconstructs freshly loaded BDOS state, retains that drive when it is
available, establishes a private stack, and prints `CR LF`, the drive letter,
and `>`.

## Command input and parsing

CCP reads one BDOS console-buffer line. The command language is 7-bit ASCII.
Lowercase letters are converted to uppercase for recognition, file control
blocks, and the command tail; console echo remains the bytes handled by BDOS.
Leading and repeated spaces are accepted, and an empty line prints another
prompt without a diagnostic. The Triptych console profile accepts at most 127
characters before the terminating carriage return.

A drive-only command such as `A:` selects that drive and updates `$0004`.
The six built-in command names are `DIR`, `ERA`, `REN`, `SAVE`, `TYPE`, and
`USER`. Any other valid command word names a transient `.COM` program.
Built-ins and transients accept a drive prefix where their CP/M syntax permits
one. File references require a non-empty name of at most eight bytes and an
optional type of at most three bytes. Inside either field, the CP/M 2.2
characters `< > , ; : [ ] % | ( ) / \` are rejected; period and equals are
grammar delimiters. `?` matches one position and `*` expands to `?` through the
remainder of that field. `DIR` and `ERA` accept those ambiguous references;
`TYPE`, `REN`, `SAVE`, and transient command names require an unambiguous
reference and reject either wildcard.

Malformed, missing, ambiguous, or extra operands must be rejected before a
mutating BDOS call. The exact diagnostic transcript for each command family is
fixed by its reviewed fixture rather than by private parser state.

## Transient-program contract

For a transient command CCP:

1. constructs an unambiguous command FCB with type `COM`;
2. opens it on the explicit or current drive;
3. loads complete 128-byte records beginning at `$0100` using BDOS DMA and
   sequential-read calls;
4. rejects a program with any record beyond `$E3FF` before resident memory is
   overwritten;
5. initializes default FCBs from the first two operands;
6. publishes the uppercase command tail at `$0080`;
7. restores the default DMA address to `$0080`;
8. places a zero warm-boot return address on the transient stack; and
9. enters the program at `$0100`.

The tail contains the complete remainder after the command word, including
its leading delimiter. Byte `$0080` is its length, bytes from `$0081` are the
tail, and the following byte is zero in the frozen Triptych compatibility
profile. A default FCB uses drive zero for the current drive or one through
sixteen for an explicit `A:` through `P:` prefix. Unused name and type bytes
are spaces; transient fields through offset 15 are zero.

The public probe `CCPPROBE b:foo*.bar baz.qux` distinguishes all of those
choices. Both the oracle and the first Triptych vertical slice publish:

```text
TAIL=13: B:FOO*.BAR BAZ.QUX
TERM=00
FCB1=02|FOO?????|BAR
FCB2=00|BAZ     |QUX
```

Its ordinary `RET` reaches the BIOS warm-boot vector and returns to a fresh
prompt.

## Built-in command surface

| Command     | Required behavior                                                    |
| ----------- | -------------------------------------------------------------------- |
| `DIR [afn]` | list matching visible files for the current user; default to `*.*`   |
| `ERA afn`   | delete all matching files; confirm the special `*.*` case            |
| `REN n=o`   | rename one unambiguous old name to one unambiguous new name          |
| `SAVE n u`  | write `n` 256-byte pages beginning at `$0100` to an unambiguous file |
| `TYPE ufn`  | emit file records until CP/M text EOF `$1A` or physical EOF          |
| `USER n`    | select and report a decimal user number from 0 through 15            |

`DIR`, `ERA`, and `REN` operate through public FCB calls. `SAVE` uses create,
sequential write, and close. `TYPE` uses open and sequential read. `USER` uses
BDOS function 32. The CCP must not duplicate directory geometry, allocation,
or media policy already owned by BDOS.

## Error and restart behavior

The acceptance suite covers missing transients, malformed command lines,
missing files, an existing rename destination, absent drives, read-only files
and disks, full directories, full disks, load overflow, and failed physical
I/O. No rejected command may mutate unrelated disk, FCB, page-zero, or
resident state. After a recoverable error, another command must work. BDOS
fatal errors may transfer through warm boot and reload CCP.

## Completion gate

The machine-readable matrix at `test/ccp/fixtures/feature-matrix.json` is the
feature-completeness ledger. Publication requires every row to be `proved`,
the exact 2 KiB resident account including worst-case stack and workspace,
successful native and WASM scenarios for every bundled application, and a
fresh `npm run check`.

All current execution evidence is host-model evidence. ESP32-S3 serial,
microSD, reset, latency, and power-loss behavior require later hardware runs.

## Reference

[Digital Research's CP/M Operating System Manual](https://bitsavers.org/pdf/digitalResearch/cpm/CPM_Operating_System_Manual_Jul82.pdf)
defines the CP/M 2 command language, CCP built-ins, transient conventions, and
BDOS interface.
