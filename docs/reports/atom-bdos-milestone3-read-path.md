# Atom BDOS Milestone 3 read-path checkpoint

Status: complete checkpoint in host models; Milestone 3 remains active

Date: 2026-09-02

## Result

The Triptych BDOS now implements directory search, file open, unmodified file
close, sequential read, random read, file-size calculation, and
sequential-to-random record conversion on top of the earlier DPB-driven disk
state. The implemented public calls are 0 through 18 except delete, call 20,
calls 24 through 29, calls 31 through 33, and calls 35 through 37.

This remains an interface-driven replacement. The implementation consumes
32-byte public directory entries, 36-byte caller FCBs, BIOS DPH/DPB pointers,
and the 17-entry BIOS jump table. No legacy implementation source or private
BDOS addresses are inputs.

## Directory and FCB behavior

The reset scan records the highest live directory entry while rebuilding the
allocation vector. Search first and next then visit only that declared live
range, avoiding speculative reads after the directory's high-water mark.
Matching includes the current user, the 8.3 name with question-mark wildcards,
logical extent fields, and masks directory attribute bits from filename
comparisons.

Search publishes the containing 128-byte directory record at the current DMA
address and returns its slot number from 0 through 3. Open instead imports
directory fields 12 through 31 into the caller's FCB and marks S2 as
unmodified. Closing such an FCB performs no disk write. Dirty close is deferred
to the mutation milestone.

Sequential reads select one-byte or two-byte allocation references from DSM,
derive block and record positions from BSH/BLM, translate logical sectors
through the BIOS, and increment the FCB sequential record. A full extent
searches for the following extent without embedding disk geometry. Random read
maps the public 24-bit record into EX/S2/CR and restores the caller's prior
sequential record after the transfer.

## Differential proofs

The enabled replacement sequences now cover:

- exact open, sequential-read, end-of-file, search, and unmodified-close
  behavior;
- wildcard continuation and CP/M user isolation;
- record 127 and an absent following extent;
- one-byte and two-byte allocation maps on different DPBs;
- file-size and sequential-to-random metadata conversion; and
- an injected BIOS read failure, including the exact
  `\r\nBdos Err On A: Bad Sector` transcript, acknowledgement, unchanged DMA,
  FCB advancement, and 59-call BIOS trace.

The focused direct suite has 83 checks at this checkpoint. Every enabled path
restores the caller's stack, and the deepest measured resident-stack use is 16
bytes.

## Headless whole-system proofs

`triptych-bdos-dir-type.json` stages input only after the retained CCP reaches
its prompt. It runs `DIR`, checks that multi-extent files appear once, runs
`TYPE README.TXT`, and pins all 247 serial bytes plus intermediate and final
80-by-24 ANSI screen hashes.

`triptych-bdos-edit-ansi-quit.json` launches the real `EDIT.COM`, opens
`INPUT.NU`, checks its full-screen ANSI display, injects Ctrl-Q only after the
editor is ready, and proves an unchanged disk image on return to `A>`.

These execute in the Rust WebAssembly host. They are deterministic host-model
proofs, not measurements of ESP32-S3 serial, SD-card, or timing behavior.

## Size and remaining work

Standalone Atom 0.2.0 and the development-only AZM 0.4.0 adapter produce the
same fixed 3,584-byte image with SHA-256
`593ec3f3dc99302005f77a33cd64c276076eb6eb303c0308937bd67a13b06325`.
Code, tables, and mutable variables occupy `$EC00..$F64F` (2,640 bytes). The
64-byte stack occupies `$F650..$F68F`, leaving 880 bytes at `$F690..$F9FF`.

The next checkpoint is the mutation boundary: delete, make, sequential write,
rename, attributes, dirty close, allocation failure, directory failure, and
write-error atomicity. Because only 880 bytes remain before optimization, that
work begins with a current assembled-byte census and consolidation of the
duplicated record-address and 24-bit record-conversion paths.
