# Triptych Atom CCP roadmap

Status: active plan

Date: 2026-09-03

## Outcome

Replace the retained transitional CCP with a Triptych-authored CP/M
2.2-compatible command processor in original Atom-compatible Z80 assembly.
It remains a strict 2 KiB drop-in, boots the existing Triptych BDOS and BIOS,
and runs existing COM programs without a new guest interface.

The legacy executable is a black-box development oracle. Its implementation
source is not an input. The rewrite does not include BDOS, BIOS, applications,
video, sound, transport, or host UI changes.

## Chosen shape

Two approaches were considered. A strict CCP replacement preserves page zero,
BDOS calls, transient loading, command syntax, and the 2 KiB resident slot. An
enhanced Triptych shell could instead introduce history, completion, richer
ANSI editing, and new services. The strict replacement is selected because it
keeps every existing COM application as a real compatibility client and
changes only one resident component. Shell extensions remain a later CCP v2
or transient application.

Tests select `systemCcp: oracle` or `systemCcp: triptych` without exposing that
choice to guest software. Production native and WASM image builders install the
Triptych CCP after the six built-ins, bundled applications, and self-assembly
pass. The retained CCP remains available through an explicit oracle selection
in development tests. The matrix keeps `publicationReady` false until the
deeper failure, parser, and resident-stack rows pass.

## Roadmap

### Milestone 0 — contract, oracle, and matrix (complete)

- freeze the 2 KiB oracle digest and fixed memory map;
- publish the command, page-zero, loader, built-in, and error contracts;
- make the completeness ledger machine-checkable; and
- separate host-model observations from later hardware evidence.

Exit: the target and every required behavior have a named acceptance row.

### Milestone 1 — differential harness and public probe (complete)

- add independent CCP selection to the shared headless scenario format;
- assemble and install repository-owned transient probes from source;
- run the same page-zero/FCB/tail/return probe against both CCPs; and
- pin exact transcripts, terminal states, binaries, and starting disks.

Exit: a plausible wrong FCB layout, tail boundary, terminator, stack return,
or warm restart fails before built-in work begins.

### Milestone 2 — prompt, parser, and transient vertical slice (complete)

- implement cold/warm entry, prompt, uppercase command buffer, command FCB,
  bounded COM loading, page-zero publication, transient stack, and return;
- add blank, unknown, malformed, drive-only, missing-file, and load-limit
  probes; and
- qualify `SMOKE.COM` before adding built-ins.

Exit: the Triptych CCP loads a real transient, supplies both FCBs and the tail,
returns through warm boot, and recovers from each loader failure.

### Milestone 3 — read-only built-ins (complete)

- implement `DIR` and `TYPE` through BDOS;
- freeze default arguments, wildcards, user visibility, output pagination and
  control-key behavior; and
- qualify the existing directory, editor, assembler, and compiler read paths.

Exit: oracle and Triptych scenarios agree on the reviewed `DIR` and `TYPE`
matrix without a host-side filesystem shortcut.

### Milestone 4 — mutation built-ins (active)

- implement `ERA`, `REN`, and `SAVE` through BDOS;
- prove confirmation, replacement rejection, read-only, full-disk,
  full-directory, partial-write, retry, and neighboring-file preservation; and
- compare exact exported disks where mutation succeeds.

Exit: every mutating command is failure-atomic at the documented boundary.

### Milestone 5 — user and command-language completion

- implement `USER` and drive selection;
- cover delimiters, case, limits, invalid characters, wildcard boundaries,
  extra operands, decimal range, and generated command lines; and
- finalize exact diagnostics where the manual or oracle is authoritative.

Exit: every parser and built-in matrix row is proved, including recovery by a
subsequent valid command.

### Milestone 6 — resident and application qualification (active)

- account code, immutable data, mutable workspace, load scratch, private
  stack, and free bytes inside `$E400..$EBFF`;
- qualify `SMOKE.COM`, `EDIT.COM`, `ATOM.COM`, `NUC.COM`, generated programs,
  and the CCP probe on the portable host;
- assemble the CCP with standalone Atom and then inside CP/M; and
- run equivalent native and WASM headless scenarios.

Exit: all matrix rows are `proved`; no byte or dependency lies outside the
declared boundary.

### Milestone 7 — publication and hardware follow-up (active)

- switch native, browser, and firmware image preparation to the Triptych CCP;
- run `npm run check`, publish GitHub Pages, and verify the fetched artifact;
- retain the oracle only as a development fixture; and
- repeat boot, command, application, reset, and disk tests on the ESP32-S3.

Exit: the hosted demonstration contains the Triptych CCP. Hardware claims
remain explicitly pending until the board arrives.

## Immediate next checkpoint

Publish and verify the browser build containing the Triptych CCP. Then finish
the Milestone 4 failure matrix for read-only media, directory-full, disk-full,
and partial-write cases, followed by generated parser boundaries and the
worst-case stack proof.
