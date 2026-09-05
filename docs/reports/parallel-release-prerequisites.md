# Parallel release prerequisites

2026-09-05. These changes prepare S4; they do not complete the distribution
builder or migrate the running browser to new component releases.

Two exclusive writers worked on disjoint file sets. Different read-only
reviewers checked each implementation, and the integration lead inspected
both diffs before running the combined repository check.

The combined `npm run check` passed on macOS with historical assembler imports
blocked: 196 Vitest tests, seven browser tests, both native PTY paths, resident
system checks and Rust checks/builds. New-disk guest acceptance remains pending.

## Input identity

The component lock now permits a Git source to select `verified-release` with
an exact artifact size, SHA-256, and local manifest/provenance paths. Its 31
tests cover required metadata, trusted recipe selection, size limits, unsafe
paths and separation from historical prebuilts. This is structural validation:
the future recipe must read and verify bytes, source association and filesystem
containment before installation.

Portable CP/M `v0.1.0` was downloaded from its public release after publication.
The downloaded artifacts match the green CI-produced inputs:

| Artifact        | SHA-256                                                            |
| --------------- | ------------------------------------------------------------------ |
| `ccp.bin`       | `d5f90f3c7cac8ad902ab4224e9f09ba344a8d30bee63dc7622d7fd1db65b2476` |
| `bdos.bin`      | `c5fc4d7dd29bf8914c4735165747e3b35dca3b8999a9f70035d972ff602718fc` |
| `manifest.json` | `2b4b1ae79dc5b6f20de5f6eb5ab0a328ccc6bd90cd9dc74b0a24a79e02252136` |

The release selects `579657f9177b31e1fccf0c05f72ba2ee76f3d052`. This verification
does not mean Triptych already consumes it.

## Fresh media

`createBlankCpm22Disk()` creates 256,256 logical bytes with a 256,512-byte
backing. Only the 2,048-byte directory at offset 6,656 is filled with E5;
system records, data and trailing padding are zero. Each call owns its buffer.
It installs no operating system and never opens a user's saved disk.

Three new tests check every region, independent allocation, empty and
multi-extent files, padding and nonmutation. Independent review also compared
the geometry against the BIOS. The installer/reader round-trip is not a guest
BDOS proof; the release-disk acceptance suite must supply that evidence.

## Next integration gate

Implement the trusted release-input verifier and populated production lock,
then build a private fresh disk from OS, application and Triptych BIOS inputs.
Keep historical oracle fixtures separate. Prove deterministic output and the
guest edit/build/run workflow before switching browser or native defaults.
