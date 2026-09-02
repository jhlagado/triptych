# Atom BDOS Milestone 3 disk-state checkpoint

Status: complete checkpoint in host models; Milestone 3 remains active

Date: 2026-09-02

## Result

The Triptych BDOS now owns the CP/M disk-state layer needed by the later file
services. Functions 13, 14, 24 through 29, 31, 32, and 37 implement reset,
selection, login and read-only vectors, current drive, DMA, allocation-vector
and DPB discovery, user state, write protection, and drive reset. Functions 38
and 39 retain the contract's deterministic zero result.

This is original Atom-compatible Z80 assembly written against the public
CP/M and Triptych BIOS interfaces. No legacy BDOS source, symbol, routine, or
private address is linked or referenced.

## Interface-driven disk discovery

Login calls BIOS `SELDSK` and treats its returned DPH as the only source for
the sector-translation table, directory buffer, DPB, and allocation vector.
The DPB then supplies sectors per track, maximum allocation block, maximum
directory entry, reserved-directory mask, and reserved-track count.

Reset performs the following externally observable sequence:

1. restore DMA to `$0080`;
2. select drive A and retain its public DPH;
3. clear the BIOS-owned allocation vector and apply DPB `AL0/AL1`;
4. home the drive;
5. read exactly the directory records implied by `DRM` using the DPB track
   offset and sectors per track; and
6. restore the caller's DMA after every temporary directory read.

Each live directory entry contributes its nonzero allocation blocks to the
BIOS-owned allocation vector. Eight-bit and sixteen-bit allocation maps are
selected from the DPB's maximum block value.

## Contract proofs

The standard `disk-state-roundtrip.json` case matches the frozen oracle's
exact 99-call BIOS trace and its final track, sector, DMA, login vector,
read-only vector, user, DPB, and allocation-vector observations.

`absent-drive.json` proves the black-box compatibility path for a zero
`SELDSK` result. The replacement emits the exact byte sequence
`\r\nBdos Err On B: Select`, consumes one console acknowledgement, and
transfers through the public warm-boot entry.

`disk-geometry-discovery.json` intentionally uses eight sectors per track,
one reserved track, eight directory entries, and 32 allocation blocks. Both
the oracle and replacement read only the two declared directory records,
produce allocation bytes `$A0,$00,$00,$00`, finish on track 1 sector 2, and
match BIOS trace SHA-256
`b6b03c2e814487a78d02aafe7cba64d1dc321f90a45f11cb50d64b32df663862`.
This is the guard against accidentally embedding the initial IBM 3740
geometry in BDOS code.

## Size and stack

AZM 0.4.0 produces a fixed 3,584-byte image with SHA-256
`99e81d3aa1f8bcab99fa309924751b161c43d7594814dfe782ea29d4320cb4f4`.
Code, tables, and mutable variables occupy `$EC00..$F1AC` (1,453 bytes). The
64-byte private stack occupies `$F1AD..$F1EC`, leaving 2,067 bytes at
`$F1ED..$F9FF`. The deepest observed path uses 14 stack bytes. These are host
emulator measurements for the currently enabled fixtures, not ESP32-S3
hardware measurements.

## Next checkpoint

The next implementation unit is directory search and file open: functions 17,
18, and 15. It will reuse the same DPB-driven record iterator, match FCB names
and wildcards within the current user, and publish the selected directory
entry into the caller's DMA/FCB only through the documented CP/M interface.
That is the prerequisite for proving `DIR`, then function 20 sequential reads
and `TYPE`.
