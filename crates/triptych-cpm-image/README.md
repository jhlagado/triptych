# Triptych CP/M image library

This reusable library owns image parsing and filesystem transformations. The
host-only [`triptych-cpm-cli`](../triptych-cpm-cli/) package provides the
`triptych-cpm` executable described below. The library retains Rust 1.85 support;
the CLI requires Rust 1.89. Neither package emulates a CPU.

`triptych-cpm` manages development copies of the legacy IBM 3740 disk and the
2 MiB and 8 MiB disk profiles. File listing, import and export use user 0.
Migration preserves files belonging to all sixteen users.

```text
triptych-cpm create SOURCE-IMAGE WORKING-IMAGE
triptych-cpm format FORMAT SYSTEM-AREA NEW-IMAGE
triptych-cpm migrate FORMAT SOURCE-IMAGE SYSTEM-AREA NEW-IMAGE
triptych-cpm list IMAGE
triptych-cpm import IMAGE MAC-FILE [CPM-NAME]
triptych-cpm export [--text] [--force] IMAGE CPM-NAME MAC-FILE
```

The canonical image contains 77 tracks, 26 128-byte records per track, two
system tracks, 1 KiB allocation blocks, and 64 directory entries. `create`
pads its 256,256 bytes to 256,512 bytes so the existing native host can expose
complete 512-byte backing sectors. The additional bytes are outside the CP/M
disk parameter block and are not filesystem capacity.

`FORMAT` is `ibm3740`, `triptych-cpm-2m-v1` or `triptych-cpm-8m-v1`.
The 2 MiB profile has 2,097,152 bytes, a 16,384-byte system area, 2 KiB
allocation blocks and 1,024 directory entries. Initially free file storage
is 2,048,000 bytes; see its
[geometry contract](../../docs/specifications/cpm-two-mib-v1.md).
The 8 MiB profile has exactly
8,388,608 bytes, a 16,384-byte system area, 2 KiB allocation blocks and 512
directory entries. Its initially free file storage is 8,355,840 bytes. The
[disk-profile contract](../../docs/specifications/cpm-disk-profiles-v1.md)
records the complete geometry and the separate guest qualification gates.

`SYSTEM-AREA` must be a file containing the complete target system area:
6,656 bytes for the legacy format or 16,384 for either larger format. The caller
must supply compatible resident software; the utility checks the area length,
not whether those bytes can boot. `format` creates an empty filesystem with
that area. `migrate` copies logical files into a new filesystem and preserves
user numbers, per-extent attributes, empty files and record-rounded contents.
Malformed or unsupported sparse sources fail without skipping files.

Both commands refuse an existing output, including the input path. Keep the
original image as a recovery backup: conversion changes allocation layout and
system records, and is not an in-place expansion. `create` still makes a
sector-aligned copy without converting the filesystem.

Imports are assembled in memory after validating the image, available blocks,
directory entries, extent order, and duplicate allocations. Publication uses
a same-directory atomic replacement. The final CP/M record is padded with
`$1A`. Ordinary binary export retains that record padding; explicit `--text`
trims trailing `$1A` bytes.
