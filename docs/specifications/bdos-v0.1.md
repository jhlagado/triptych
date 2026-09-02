# Triptych CP/M 2.2 BDOS v0.1 contract

Status: draft replacement contract

Date: 2026-09-02

## Purpose and authority

This document defines the observable boundary that a Triptych-authored BDOS
must implement. It specifies compatibility, not internal algorithms. Source
structure, labels, instruction selection, private tables, and caching choices
remain implementation details.

The authority order is:

1. the documented CP/M 2 system interface in Chapter 5 of the Digital Research
   CP/M Operating System Manual;
2. this Triptych contract for fixed addresses and deterministic choices;
3. contract fixtures derived from the manual;
4. black-box compatibility observations from the frozen transitional BDOS; and
5. the new implementation.

If the manual and old executable disagree, the discrepancy is recorded before
choosing behavior. An old implementation detail does not silently become a
contract.

## Resident layout

| Region or entry   |        Address | Contract                                                     |
| ----------------- | -------------: | ------------------------------------------------------------ |
| Warm boot vector  |        `$0000` | Three-byte jump installed by BIOS                            |
| Current I/O byte  |        `$0003` | One byte                                                     |
| Current drive     |        `$0004` | Zero-based drive number                                      |
| BDOS vector       |        `$0005` | Three-byte jump to `$EC06`                                   |
| Default FCB       |        `$005C` | Prepared by CCP for a transient command                      |
| Default DMA       |        `$0080` | 128 bytes; restored by disk reset                            |
| Transient program |        `$0100` | `.COM` entry                                                 |
| CCP               | `$E400..$EBFF` | Retained compatibility client                                |
| BDOS              | `$EC00..$F9FF` | Entire code, immutable data, mutable data, and private stack |
| BDOS public entry |        `$EC06` | Callable through `$0005`                                     |
| BIOS              | `$FA00..$FDFF` | Triptych-owned hardware-dependent component                  |

The BDOS slot is exactly 3,584 bytes. No implementation-owned byte may be
hidden in page zero, the TPA, CCP, BIOS, or host. Page-zero locations documented
by CP/M are guest state, not private workspace.

## Call convention

A program places the function number in `C`, a byte parameter in `E`, or an
address/vector in `DE`, then executes `CALL $0005`. For normal-returning calls,
an 8-bit result appears in both `A` and `L`; a 16-bit result appears in `HL`,
with `B` equal to `H`. An unsupported function number returns zero.

BDOS is single-tasked and non-reentrant. It saves the caller's return address
and stack pointer, uses a resident private stack while active, and restores the
caller's stack on every normal return. A warm boot is a transfer of control,
not a normal return.

Only documented output registers and memory fields are portable application
state. Differential tests may record additional registers to detect accidental
nondeterminism, but do not turn them into a guest promise without an explicit
contract change.

## Function surface

The initial replacement implements the complete CP/M 2.2 range.

| `C` | Service                     | Primary input                       | Primary result                  |
| --: | --------------------------- | ----------------------------------- | ------------------------------- |
|   0 | System reset                | none                                | warm boot; no normal return     |
|   1 | Console input               | none                                | character                       |
|   2 | Console output              | `E` character                       | none                            |
|   3 | Reader input                | none                                | character                       |
|   4 | Punch output                | `E` character                       | none                            |
|   5 | List output                 | `E` character                       | none                            |
|   6 | Direct console I/O          | `E=$FF` inputs; otherwise outputs   | character or zero               |
|   7 | Get I/O byte                | none                                | I/O byte                        |
|   8 | Set I/O byte                | `E` value                           | none                            |
|   9 | Print string                | `DE` points to `$`-terminated bytes | none                            |
|  10 | Read console buffer         | `DE` points to line buffer          | length and characters in buffer |
|  11 | Get console status          | none                                | zero or nonzero                 |
|  12 | Return version              | none                                | `$0022`                         |
|  13 | Reset disk system           | none                                | none                            |
|  14 | Select disk                 | `E` drive number                    | none                            |
|  15 | Open file                   | `DE` FCB                            | directory code or `$FF`         |
|  16 | Close file                  | `DE` FCB                            | directory code or `$FF`         |
|  17 | Search first                | `DE` FCB                            | directory code or `$FF`         |
|  18 | Search next                 | prior search state                  | directory code or `$FF`         |
|  19 | Delete file                 | `DE` FCB                            | directory code or `$FF`         |
|  20 | Read sequential             | `DE` FCB                            | status code                     |
|  21 | Write sequential            | `DE` FCB                            | status code                     |
|  22 | Make file                   | `DE` FCB                            | directory code or `$FF`         |
|  23 | Rename file                 | `DE` rename FCB                     | zero or `$FF`                   |
|  24 | Return login vector         | none                                | drive bit vector                |
|  25 | Return current disk         | none                                | drive number                    |
|  26 | Set DMA address             | `DE` address                        | none                            |
|  27 | Get allocation address      | none                                | allocation-vector address       |
|  28 | Write-protect disk          | none                                | none                            |
|  29 | Get read-only vector        | none                                | drive bit vector                |
|  30 | Set file attributes         | `DE` FCB                            | zero or `$FF`                   |
|  31 | Get disk-parameter address  | none                                | DPB address                     |
|  32 | Set/get user code           | `E=$FF` gets; `E=0..15` sets        | current user code               |
|  33 | Read random                 | `DE` FCB                            | status code                     |
|  34 | Write random                | `DE` FCB                            | status code                     |
|  35 | Compute file size           | `DE` FCB                            | writes `r0..r2`                 |
|  36 | Set random record           | `DE` FCB                            | writes `r0..r2`                 |
|  37 | Reset drive                 | `DE` drive vector                   | zero                            |
|  38 | Access drive                | unsupported by CP/M 2.2             | zero                            |
|  39 | Free drive                  | unsupported by CP/M 2.2             | zero                            |
|  40 | Write random with zero fill | `DE` FCB                            | status code                     |

The table names the surface but does not replace per-call fixtures. Detailed
editing keys, FCB mutations, directory codes, record status codes, extent
rollover, and error effects become normative only when their manual-derived
fixtures are reviewed.

## BIOS dependency

The correct BIOS for Triptych is `roms/cpu/bios.asm`. It adapts the portable
CP/M boundary to Triptych's serial and logical-record ports. BDOS must not call
those ports directly.

BDOS reaches BIOS through the 17 three-byte entries at `$FA00` in this order:

1. cold boot;
2. warm boot;
3. console status;
4. console input;
5. console output;
6. list output;
7. punch output;
8. reader input;
9. home;
10. select disk;
11. set track;
12. set sector;
13. set DMA;
14. read sector;
15. write sector;
16. list status; and
17. sector translate.

The BDOS obtains disk geometry and work-vector addresses from the selected
drive's DPH and DPB. The v0.1 BIOS happens to expose one IBM 3740 drive, but
that geometry is not compiled into BDOS algorithms. This keeps the BIOS
replaceable without changing applications or BDOS.

## Disk and file state

The observable filesystem model includes:

- current drive and user number;
- logged-in and read-only drive vectors;
- current DMA address;
- per-drive DPH, DPB, allocation vector, checksum vector, and directory state;
- 32-byte directory entries and CP/M FCB fields;
- 128-byte logical records, extents, record counts, and allocation blocks; and
- search-first/search-next continuation state.

Directory and allocation updates must be published through BIOS sector writes.
A failed or rejected operation must leave unrelated directory entries,
allocation bits, FCB fields, and data records unchanged. The Triptych BIOS
currently flushes each successful CP/M sector write to the host disk boundary;
BDOS must not assume a host filesystem or a stronger hidden durability path.
Rename and set-file-attributes apply to every directory extent belonging to
the selected file, not only the extent named by the caller's current FCB
position.

## Required proofs

- every function 0 through 40 has a reviewed direct-call fixture;
- out-of-range function numbers return zero without BIOS I/O;
- normal calls restore the caller stack and do not write outside documented
  output, DMA, FCB, directory, allocation, and resident regions;
- BIOS call order and arguments match the contract for success and failure;
- console control characters and line editing match reviewed fixtures;
- FCB parsing, wildcard search, user isolation, extent rollover, and random
  record conversion are covered at boundaries;
- disk-full, directory-full, absent-drive, read-only, and failed BIOS I/O cases
  reject deterministically without unrelated mutation;
- the retained CCP boots and implements its built-in commands;
- `ATOM.COM`, `NUC.COM`, `EDIT.COM`, and generated COM programs work;
- successful guest writes survive a fresh native host process;
- native and WASM hosts produce equivalent guest-visible results;
- ANSI applications produce the expected 80-by-24 cell, attribute, cursor,
  wrap, and bell state in the DOM-free terminal model; and
- the complete linked BDOS, including worst-case stack and workspace, fits
  `$EC00..$F9FF`.

These are host-model proofs until repeated on the ESP32-S3. They make no claim
about physical SD latency, serial loss, execution pacing, power behavior, or
hardware stability.

Whole-system fixture lifecycle, byte encodings, terminal snapshots, and disk
persistence follow the
[CP/M headless scenario contract](cpm-headless-scenarios-v1.md).

## Source and build boundary

Production source will live below `roms/cpu/bdos/` and use original
Atom-compatible assembly. `%INCLUDE` may divide the implementation into
modules, but the build produces one fixed resident image. Host-side generation
or assembly helpers belong in `tools/`; direct and whole-system proofs belong
in `test/`.

The final acceptance path assembles the source with the standalone Atom tool
and, separately, with the same native Atom core inside the guest. The bundled
`ATOM.COM` profile targets ordinary programs beginning at `$0100`, so the
headless proof derives a private `$EC00..$F9FF` profile by changing only its
provenance-checked target-configuration words. It does not alter the Atom core
or enter the distributable disk. AZM may temporarily provide a development
adapter or cross-check, but the production source and firmware must not depend
on Debug80.

## Reference

[Digital Research's CP/M Operating System Manual](https://bitsavers.org/pdf/digitalResearch/cpm/CPM_Operating_System_Manual_Jul82.pdf)
defines the CP/M 2 program interface in Chapter 5 and the 17-entry BIOS
interface in Chapter 6.
