# Atom BDOS mutation and random-access checkpoint

Status: complete function surface, application, self-assembly, and publication
checkpoint

Date: 2026-09-02

## Result

The Triptych BDOS now dispatches every CP/M 2.2 function number from 0 through 40. Delete, sequential write, make, rename, set attributes, dirty close, random
write, and random write with zero fill execute through the public BIOS and
match the reviewed direct-call boundary. Unsupported functions 38 and 39
return deterministic zero.

The implementation remains interface-driven. It consumes only page-zero CP/M
state, public 36-byte FCBs, 32-byte directory entries, DPH/DPB geometry, BIOS
work vectors, and the 17-entry BIOS jump table. The retained third-party BDOS
is a development-only black-box oracle and is not linked into the replacement.

## Mutation proofs

The always-enabled direct suite now covers:

- create, first-block allocation, sequential write, dirty close, attributes,
  rename, and wildcard delete;
- full-directory and full-disk rejection;
- disk and file read-only diagnostics and warm-boot transfers;
- injected physical read and write errors with exact diagnostics and BIOS
  traces;
- one-byte and two-byte allocation maps;
- random read/write, 24-bit size and position conversion, and complete
  new-block zero filling; and
- 129 sequential records crossing from extent 0 into extent 1.

The extent proof generates 129 write calls, compares every return value and
BIOS trace with the oracle, then compares the final FCB, allocation vector, and
complete BIOS disk snapshot. The boundary call writes record 127, closes the
old extent, searches and creates the next extent, and leaves the FCB ready for
record 0 of that extent.

The same generated sequence now renames the two-extent file and compares the
complete result with the oracle. This addition exposed that the first
implementation renamed only extent zero. Rename and set-file-attributes now
scan and update every matching extent. Five injected directory-write failures
cover make, dirty close, rename, attributes, and delete; every rejected first
write preserves the persisted disk, and the same operation succeeds on retry.

The direct suite contains 89 tests. The deepest measured private-stack use in
the general fixture matrix is 20 bytes; the 129-record rollover path uses 14
bytes. Every measured normal return restores the caller's stack.

Three additional seeded state machines generate 28 mixed filesystem
transitions after creating four files. They cover sequential and random reads
and writes, closes, size and random-position conversion, attributes, renames,
deletes, searches, new allocation after deletion, and exact 128-byte payloads.
After every generated call the test checks its independent semantic model,
public return and FCB state against the frozen oracle, exact persisted disk
records, the allocation vector, the write boundary, and the resident stack.
The generated paths use at most 10 private-stack bytes.

This broader state space found two compatibility defects hidden by the earlier
fixtures. Successful rename and set-attributes returned the matching directory
slot instead of zero. Random I/O restored the prior sequential `CR` rather
than retaining the requested random record. It also showed that OPEN must copy
the directory's attribute bits into the supplied FCB. All three behaviors are
now fixed and retained by the generated tests.

## Headless compiler proof

`triptych-bdos-ccp-file-roundtrip.json` runs the retained `SMOKE.COM` through
the replacement, persists `RESULT.TXT`, then boots a fresh WASM machine and
reads the file with CCP `TYPE`. This is the headless counterpart to the native
two-process persistence proof.

`triptych-bdos-atom-compile.json` runs the retained `ATOM.COM` against the
replacement. The first WASM machine assembles `HELLO.ASM`, produces the exact
`HELLO.COM written` transcript, and exports the mutated disk. A fresh machine
boots only from that exported image and runs `HELLO.COM`, producing `Hello from
native Atom`. Both sessions pin their complete serial transcripts, 80-by-24
ANSI terminal states, and disk digests.

`triptych-bdos-nucleus-compile.json` compiles `INPUT.NU` with the retained
`NUC.COM`, pins the resulting two-extent disk image, and runs `INPUT.COM` in a
fresh machine. The program prints `OK`. This scenario found the multi-extent
rename defect because Nucleus publishes through `INPUT.$$$`: the first extent
became `INPUT.COM` while the second retained its temporary name until the BDOS
correction.

`triptych-bdos-self-assemble.json` installs the repository's current
`BDOS.ASM` into a private disk. The bundled Atom target profile is deliberately
limited to ordinary `$0100` programs, so the fixture derives `ATBDOS.COM` by
changing only six target-configuration words in the provenance-pinned
15,029-byte Atom image. That unchanged Atom core assembles the source at
`$EC00` inside CP/M. The resulting 3,584-byte `BDOS.BIN` has SHA-256
`d20bcd7c04b3600d18bb26764476616152b387d4ef831309606a54017a9fa081`,
identical to standalone Atom 0.2.0 and the development AZM cross-check.

The browser and native image preparation paths now assemble and install both
the Triptych BDOS and Triptych BIOS. A user-selected browser disk is patched in
memory; its source file remains unchanged. The Pages artifact receives a
preinstalled Triptych system disk. The current local browser-build artifact has
SHA-256
`29d393ae1b83186ef5909a311d0d38d28418a785646382ae66f28e42a980a85e`;
its `$0800..$15FF` BDOS and `$1600..$19FF` BIOS slices are byte-identical to
the separately published firmware binaries.

The native `SMOKE.COM` proof stages input after the retained CCP reaches `A>`,
creates `RESULT.TXT`, closes the first process, and reads the file through CCP
`TYPE` in a second process. The current system image before guest mutation has
SHA-256
`e80cf64d71b84a4d9af5ce8791dc4bf9ba3729d043cff1c961266f91530ff6e3`.

These are host-model proofs. They do not measure ESP32-S3 serial, SD-card,
scheduling, or power behavior.

## Publication verification

Commit `2d9c4bc` passed the GitHub Actions `WASM GitHub Pages` build and deploy
jobs in run 33635359798. The workflow reran the repository gate, replayed every
headless CP/M scenario, rebuilt the browser host, and published the artifact.
Fetching `https://jhlagado.github.io/triptych/cpm22.img` after deployment
returned 256,256 bytes with SHA-256
`29d393ae1b83186ef5909a311d0d38d28418a785646382ae66f28e42a980a85e`,
identical to the local browser build. The application is available at
`https://jhlagado.github.io/triptych/`.

## Resident account

Standalone Atom 0.2.0 and the development-only AZM 0.4.0 adapter produce the
same 3,584-byte image with SHA-256
`d20bcd7c04b3600d18bb26764476616152b387d4ef831309606a54017a9fa081`.

| Account                    | Range          | Bytes |
| -------------------------- | -------------- | ----: |
| Code and immutable tables  | `$EC00..$F8C9` | 3,274 |
| Mutable resident workspace | `$F8CA..$F94A` |   129 |
| Private stack reservation  | `$F94B..$F98A` |    64 |
| Unused resident bytes      | `$F98B..$F9FF` |   117 |

The earlier read-path checkpoint left 880 bytes. Reusing the directory read
path during login and sharing the 24-bit FCB record conversion recovered 81
bytes before the mutation work. This compression pass merged the two directory
write suffixes, shared OPEN/SEARCH initialization, folded allocation-cell
addressing, and replaced twelve copies of `FCB + 32` with one helper. The
randomized fixes then simplified random-position retention and removed one
workspace byte. Applying rename and attribute changes across all extents costs
22 of the recovered bytes, leaving 117 bytes free without moving state outside
the declared resident account.

## Follow-up boundary

The BDOS milestone has no remaining acceptance work. A clean-room CCP rewrite
can now be planned against the frozen BDOS and headless-application contracts.
ESP32-S3 serial, SD-card, scheduling, and power measurements remain a separate
hardware milestone.
