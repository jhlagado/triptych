# Atom BDOS mutation and random-access checkpoint

Status: complete function surface in host models; durability and compression
work remain active

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

The direct suite contains 89 tests. The deepest measured private-stack use in
the general fixture matrix is 20 bytes; the 129-record rollover path uses 14
bytes. Every measured normal return restores the caller's stack.

## Headless compiler proof

`triptych-bdos-atom-compile.json` runs the retained `ATOM.COM` against the
replacement. The first WASM machine assembles `HELLO.ASM`, produces the exact
`HELLO.COM written` transcript, and exports the mutated disk. A fresh machine
boots only from that exported image and runs `HELLO.COM`, producing `Hello from
native Atom`. Both sessions pin their complete serial transcripts, 80-by-24
ANSI terminal states, and disk digests.

The browser and native image preparation paths now assemble and install both
the Triptych BDOS and Triptych BIOS. A user-selected browser disk is patched in
memory; its source file remains unchanged. The Pages artifact receives a
preinstalled Triptych system disk. The clean browser-build artifact and the
file served by GitHub Pages both have SHA-256
`e67234b50fe63aea7cb769b0517b0360450745f7765754c9d77fa7f65924d30c`;
its `$0800..$15FF` BDOS and `$1600..$19FF` BIOS slices are byte-identical to
the separately published firmware binaries.

The native `SMOKE.COM` proof now stages input after the retained CCP reaches
`A>`, creates `RESULT.TXT`, closes the first process, and reads the file through
CCP `TYPE` in a second process. Its prepared system image has SHA-256
`e6fb64119c5d44ba85ccc9e23b8018da17399aeebb21d80b7bfc736bbdf25002`.

These are host-model proofs. They do not measure ESP32-S3 serial, SD-card,
scheduling, or power behavior.

## Resident account

Standalone Atom 0.2.0 and the development-only AZM 0.4.0 adapter produce the
same 3,584-byte image with SHA-256
`14680a854b190be022104ba2c3256e1ec1e64fee6f4f1ada51b78b38ac954cca`.

| Account                    | Range          | Bytes |
| -------------------------- | -------------- | ----: |
| Code and immutable tables  | `$EC00..$F92C` | 3,373 |
| Mutable resident workspace | `$F92D..$F9AC` |   128 |
| Private stack reservation  | `$F9AD..$F9EC` |    64 |
| Unused resident bytes      | `$F9ED..$F9FF` |    19 |

The earlier read-path checkpoint left 880 bytes. Reusing the directory read
path during login and sharing the 24-bit FCB record conversion recovered 81
bytes before the mutation work. The complete function surface now leaves only
19 bytes, so further semantic work or defensive checks require a new measured
compression pass rather than consuming the remaining margin casually.

## Remaining work

The next acceptance steps are:

1. add randomized filesystem state-machine and broader directory-write failure
   atomicity proofs;
2. compress the resident implementation while retaining every direct and
   headless discriminator;
3. establish a successful Nucleus compile-and-run scenario; and
4. assemble the BDOS source through the in-guest Atom path.
