# Triptych Atom BDOS roadmap

Status: active plan

Date: 2026-09-02

## Outcome

Replace the transitional Digital Research-derived BDOS binary with a
Triptych-authored CP/M 2.2-compatible BDOS, written as original
Atom-compatible Z80 assembly. The replacement must boot the existing CCP and
run existing CP/M programs without changing their interface.

This is a specification-driven reimplementation. It is not a translation,
transcription, cleanup, or mechanical rearrangement of an existing BDOS
source. The old executable may answer black-box compatibility questions until
the replacement passes the same tests, but its implementation is not an input
to new production code.

The work is limited to the CPU unit. It does not change video, sound, module
transport, ESP32 pin assignments, or the host-visible disk protocol.

## Chosen architecture

Two shapes were considered.

| Candidate                    | Shape                                                                                                            | Advantage                                                | Disqualifying cost                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Strict external replacement  | Keep the CP/M entry, function set, FCB rules, memory placement, and BIOS interface; organize new code internally | Existing CCP and COM programs remain useful test clients | Requires disciplined compatibility work within the 3,584-byte slot         |
| New modular kernel interface | Introduce new guest calls, filesystem objects, and shell together                                                | Freer internal design and easier extensions              | Replaces several boundaries at once and loses the existing software oracle |

Triptych chooses the strict external replacement. Internal source will still
be split into purposeful Atom modules for entry/dispatch, console, drive state,
directory operations, allocation, sequential I/O, random I/O, and resident
workspace. Those modules are not new guest-visible interfaces.

The existing Triptych BIOS is the hardware-dependent CP/M component and
remains the correct BIOS for this machine. The new BDOS calls only its standard
17-entry jump table. The existing CCP stays in place until BDOS compatibility
is proved; replacing the CCP is a later, separately scoped project.

## Independent-rewrite discipline

New source is derived from three allowed forms of evidence:

1. the public CP/M 2 system-call and BIOS interface described in the Digital
   Research operating-system manual;
2. the Triptych contracts and machine implementation; and
3. black-box observations made by running documented calls or programs against
   the frozen transitional binary.

The following are explicitly excluded from production implementation work:

- copying labels, comments, control flow, data layout, instruction sequences,
  or routines from an existing BDOS source;
- mechanically translating 8080 or Z80 source into Atom syntax;
- treating byte-for-byte identity with the old BDOS as a goal; and
- importing legacy implementation source into `roms/cpu/bdos/`.

Tests state inputs and observable results. When an undocumented behavior must
be retained for compatibility, the test records the program that exposed it,
the old binary digest, and the observed result without encoding how the old
binary produced it. This is an independent rewrite, not a claim that the team
has conducted a legally isolated clean-room process.

## Fixed boundaries

- public call path: `CALL $0005`, which jumps to `$EC06`;
- resident BDOS slot: `$EC00..$F9FF`, exactly 3,584 bytes including private
  data and stack;
- CCP slot: `$E400..$EBFF`, retained during this roadmap;
- BIOS base: `$FA00`, with the standard 17 three-byte jump entries;
- transient program origin: `$0100`;
- default DMA address after disk reset: `$0080`;
- first disk profile: drive A, IBM 3740 layout, 77 tracks, 26 sectors per
  track, and 128-byte logical records;
- I/O boundary: BDOS uses the BIOS, never Triptych host ports or files
  directly; and
- assembly boundary: source uses the Atom-compatible common subset and must
  eventually assemble inside CP/M with `ATOM.COM`.

The normative details are in the
[BDOS v0.1 contract](../specifications/bdos-v0.1.md).

## Verification strategy

Every function is proved at two levels.

The direct-call harness starts a Z80 at `$EC06` with explicit registers,
memory, FCB, DMA, directory, allocation vector, and scripted BIOS responses.
It captures return registers, changed memory, BIOS call order and arguments,
console output, disk writes, final stack pointer, and exit reason. The same
case first runs against the frozen binary and then the Triptych replacement.

Whole-system tests then cold-boot the retained CCP and exercise real programs.
They check console transcripts, directory contents, exact file bytes, working
disk persistence across a fresh host process, and failure paths. Passing only
the direct harness is insufficient because CCP and application behavior can
depend on interactions between calls.

Whole-system scenarios also feed the serial output into Triptych's DOM-free
80-by-24 ANSI terminal model. Headless assertions compare visible cells,
attributes, cursor position, pending wrap, and bell count as well as raw bytes.
This makes the CCP and full-screen applications reproducible in CI without a
browser window. Browser rendering remains a separate thin view of the same
terminal state. The reusable fixture lifecycle and host-adapter boundary are
defined by the
[CP/M headless scenario contract](../specifications/cpm-headless-scenarios-v1.md).

Correctness precedes optimization. Exact bytes used, largest stack depth, and
resident workspace are reported only for a behaviorally passing build. The
linked image fails the build if any byte extends past `$F9FF` or if it places
mutable state in the CCP or TPA.

## Roadmap

### Milestone 0 — freeze the boundary and oracle (complete)

Work:

- record the exact transitional image and CCP, BDOS, and BIOS component
  digests;
- freeze the memory map and BIOS jump-table boundary;
- publish this roadmap and the initial normative contract; and
- make the baseline facts machine-checkable in `npm run check`.

Exit: the repository rejects a silently changed oracle or system layout and
clearly separates third-party compatibility material from future Triptych
source.

### Milestone 1 — build the differential contract harness (complete)

Work:

- add an independent test-program generator for calls 0 through 40;
- add a scripted BIOS double that records the 17-entry interface;
- define deterministic snapshots for registers, memory, console, directory,
  allocation state, disk records, and the headless ANSI screen;
- obtain expected results from the manual wherever specified and from
  black-box comparison only where compatibility needs more detail; and
- prove stack restoration, out-of-range function behavior, and warm-boot
  behavior before implementing services.

Exit: the frozen BDOS passes the harness, every fixture identifies its evidence
source, and no fixture depends on legacy symbols or implementation addresses
other than the public `$EC06` entry.

### Milestone 2 — entry, dispatch, and console services (complete)

Work:

- create original Atom source with a private stack and complete dispatcher;
- implement calls 0 through 12;
- establish I/O byte, console editing, control-character, and abort behavior;
  and
- return the documented values in both `A/L` and `B/H`.

Exit: calls 0 through 12 pass direct differential tests, the CCP reaches a
prompt, and a console-only COM program runs and returns.

### Milestone 3 — disk discovery and read path (complete)

Disk state, open, unmodified close, search first/next, sequential read, random
read, file size, and sequential-to-random conversion pass their differential
fixtures. The retained CCP runs `DIR` and `TYPE`; `EDIT.COM` opens and displays
`INPUT.NU`; and `ATOM.COM` reads `HELLO.ASM`. Two-byte allocation maps and a
deliberately non-IBM geometry have independent fixtures.

Work:

- implement calls 13 through 18, 20, and 24 through 32 as their dependencies
  require;
- consume DPH and DPB data supplied by the BIOS rather than embedding the
  current geometry in BDOS code;
- implement login, current drive/user, DMA, directory scanning, open, close,
  and sequential read; and
- validate FCB, extent, checksum, allocation-vector, and read-only semantics.

Exit: the retained CCP implements `DIR` and `TYPE`, and `ATOM.COM`, `NUC.COM`,
and `EDIT.COM` can open and read their inputs under direct and whole-system
proofs.

### Milestone 4 — mutation and durability (complete)

Current checkpoint: delete, make, rename, sequential write, attributes, dirty
close, read-only rejection, full-directory and full-disk rejection, injected
write failure, and a 129-record two-extent write all match the reviewed oracle
boundary. `ATOM.COM` creates `HELLO.COM`, and the file executes in a fresh WASM
machine. The same create-and-read workflow now survives two fresh native host
processes with the Triptych BDOS and BIOS installed into the working image.

Work:

- implement call 19 delete, make, rename, sequential write, and attributes;
- prove block allocation, extent rollover, full-directory, full-disk,
  read-only, and failed-write behavior; and
- prove that a successful close/flush survives a fresh native host process.

Exit: create, replace, rename, delete, and multi-extent file scenarios produce
the expected directory and data bytes without corrupting neighboring files.

### Milestone 5 — random access and complete function set (complete)

All public function numbers 0 through 40 are dispatched. Random read/write,
file size, sequential-to-random conversion, and zero-filled random write pass
the complete reviewed random-access sequence. Functions 38 and 39 return
deterministic zero. Three seeded filesystem state machines generate creates,
sequential and random I/O, closes, size queries, attributes, renames, deletes,
searches, and block reuse; each transition checks its independent model and
the frozen oracle's public state and persisted disk records.

Work:

- implement calls 33 through 40, including file-size calculation, random
  record conversion, and zero-filled random write;
- define deterministic behavior for unsupported calls 38 and 39; and
- finish the complete CP/M 2.2 call matrix and error paths.

Exit: all calls 0 through 40 satisfy the direct contract suite and randomized
filesystem state-machine tests.

### Milestone 6 — system and self-host proof (complete)

The retained CCP, `DIR`, `TYPE`, `SMOKE.COM`, `EDIT.COM`, `ATOM.COM`, and
`NUC.COM` run under the replacement through the headless ANSI model. `SMOKE`
proves a file round trip across fresh machines. `ATOM.COM` assembles
`HELLO.COM`, and `NUC.COM` compiles `INPUT.NU`; both generated programs run in
fresh WASM machines. A provenance-checked high-origin profile of the same Atom
core assembles `BDOS.ASM` inside CP/M and produces the exact independently
assembled 3,584-byte resident image.

Work:

- cold-boot the existing CCP with the new BDOS and Triptych BIOS;
- run the repository's current COM suite and ANSI editor workflow;
- replay CCP and application scenarios through the headless terminal model;
- require each bundled CCP or COM application to qualify through the shared
  headless scenario contract;
- assemble a nontrivial program inside the guest with `ATOM.COM`;
- compile and execute a Nucleus program; and
- retain native and WASM transcripts and disk hashes.

Exit: the new BDOS passes the same two-process persistence and browser proofs
as the transitional system, and its own source can be assembled through the
documented Atom path.

### Milestone 7 — fit, replace, and publish (complete)

Work:

- report exact linked code, tables, workspace, stack high-water mark, and free
  bytes within the 3,584-byte slot;
- make the system image generator install the Triptych BDOS reproducibly;
- retain the old binary only as provenance-controlled test material;
- update the automatically deployed WebAssembly disk; and
- publish the proof report with host results clearly separated from later
  ESP32 measurements.

Exit: a clean checkout builds and tests a distributable Triptych system disk,
GitHub Pages boots that disk, and production execution no longer depends on the
third-party BDOS binary.

### Milestone 8 — separately plan the CCP replacement

Only after Milestone 7, specify an original Triptych CCP against the now-proven
BDOS interface. The shell may improve command syntax and presentation, but it
must not retroactively weaken the BDOS compatibility tests.

## Immediate next work

The BDOS roadmap is complete. The next project checkpoint is Milestone 8: plan
the separate clean-room CCP replacement against the frozen BDOS contract and
the shared headless scenario format, without reopening either boundary.

## References

- [Triptych BDOS v0.1 contract](../specifications/bdos-v0.1.md)
- [Triptych CPU v0.1 profile](../specifications/cpu-v0.1.md)
- [Digital Research CP/M Operating System Manual](https://bitsavers.org/pdf/digitalResearch/cpm/CPM_Operating_System_Manual_Jul82.pdf),
  Chapter 5 for the program interface and Chapter 6 for the BIOS interface
- [Transitional disk provenance](../../third_party/cpm22/PROVENANCE.md)
