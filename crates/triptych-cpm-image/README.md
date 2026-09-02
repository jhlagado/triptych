# Triptych CP/M image utility

`triptych-cpm` manages development copies of the ideal IBM 3740 CP/M 2.2 disk
used by the Triptych CPU host. It works with user-0 filenames and complete
images. It does not emulate a CPU or expose sectors as a developer workflow.

```text
triptych-cpm create SOURCE-IMAGE WORKING-IMAGE
triptych-cpm list IMAGE
triptych-cpm import IMAGE MAC-FILE [CPM-NAME]
triptych-cpm export [--text] [--force] IMAGE CPM-NAME MAC-FILE
```

The canonical image contains 77 tracks, 26 128-byte records per track, two
system tracks, 1 KiB allocation blocks, and 64 directory entries. `create`
pads its 256,256 bytes to 256,512 bytes so the existing native host can expose
complete 512-byte backing sectors. The additional bytes are outside the CP/M
disk parameter block and are not filesystem capacity.

Imports are assembled in memory after validating the image, available blocks,
directory entries, extent order, and duplicate allocations. Publication uses
a same-directory atomic replacement. The final CP/M record is padded with
`$1A`. Ordinary binary export retains that record padding; explicit `--text`
trims trailing `$1A` bytes.
