# Native CP/M working-disk report

Status: passed host milestone

Date: 2026-09-01

## Outcome

Triptych now has a native Rust utility for persistent CP/M development disks.
It creates a native-host-ready working image from the established CP/M 2.2
image, lists user-0 files and free space, imports an ordinary Mac file under a
validated CP/M 8.3 name, and exports a selected file. The interactive native
launcher can boot the named image directly, so flushed guest writes survive
later host processes.

The utility is a separate `triptych-cpm-image` crate. Filesystem policy does not
enter the portable CPU core, and the native host still provides only the
existing complete-sector service. The tool accepts the canonical 256,256-byte
IBM 3740 image and Triptych's 256,512-byte working form. It never treats the
padding required by 512-byte backing sectors as CP/M filesystem capacity.

## Publication and format checks

The library validates image size, user numbers, record counts, allocation block
bounds, duplicate allocations, and contiguous extent numbering before listing,
reading, or replacing files. An import computes its complete directory and
block allocation before changing a cloned image. The command-line utility then
publishes the replacement with one same-directory rename. Capacity or filename
failure leaves the source image unchanged.

CP/M 2.2 records do not retain an exact final byte count. Imports therefore pad
the final 128-byte record with `$1A`. Binary export preserves complete records;
the explicit `--text` option removes trailing `$1A` bytes. This avoids silently
truncating a binary whose last meaningful byte happens to equal the CP/M text
EOF marker.

## Native Atom proof

The end-to-end proof used these external inputs:

| Input                              | Licence                                | SHA-256                                                            |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------ |
| Debug80 development CP/M 2.2 image | external provenance-reviewed aggregate | `6313a5ea94f9e8bb48acf0f99e51e6432a9a1ce61e9f0c785f5e17b287b7dd7f` |
| Atom native CP/M 2.2 assembler     | GPL-3.0-only                           | `cdd5d05e3131b23288914b354929cfb5c2e1639d71c35f337e8fcec8c2bdfcbb` |
| Atom example assembly source       | project development input              | `e939a2011c04b5baaffe178c8483363387391a36f3b227a49f7b054d1f71b1db` |

Atom came from the external
[`packages/atom`](https://github.com/jhlagado/debug80/tree/main/packages/atom)
project and was not copied into Triptych. The proof rejected the artifact or
source before disk preparation if either digest differed.

The proof performed this sequence:

1. Create a persistent working image and import the pinned files as `ATOM.COM`
   and `INPUT.ASM`.
2. List both files, export the binary with record padding, and export the source
   with text EOF trimming. Both exports matched their imported bytes under the
   stated padding policy.
3. Assemble Triptych's boot ROM and BIOS and run `ATOM` inside CP/M on the
   production native Rust host. Atom reported `OUTPUT.COM written`.
4. Start a fresh native-host process against the same working image and run
   `OUTPUT`. It printed `Hello from native Atom`.
5. List the working image again and find the guest-created `OUTPUT.COM`.

This proves the native macOS development route from host source to guest Atom
to a persistent CP/M artifact and a fresh-process execution. It is host-model
evidence only; no ESP32, SD card, USB serial, or physical timing was measured.

## Reproduction

```sh
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img \
TRIPTYCH_ATOM_COM=/path/to/atom-cpm22.com \
TRIPTYCH_ATOM_SOURCE=/path/to/atom-example.asm \
npm run proof:cpm-image-native
```

Focused Rust verification is:

```sh
cargo test -p triptych-cpm-image
cargo clippy -p triptych-cpm-image --all-targets -- -D warnings
```

The next native-first slice is to give the separately provenanced Nucleus
compiler and a small Nucleus source the same import, guest compile, persistent
output, export, and host-comparison treatment.
