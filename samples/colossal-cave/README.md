# Colossal Cave Adventure disk

This recipe prepares the IF Archive's two-file 350-point Adventure for
Triptych's four-drive, two-MiB CP/M profile. It creates a data disk, not a boot
disk. Both original files remain byte-for-byte intact; only their names become
uppercase CP/M names.

On 12 September 2026, John Hardy authorised distribution from the IF Archive
source with attribution and links, while deferring further rights investigation.
`ADVENTUR.COM` retains the 1977 Small System Services, Inc. copyright notice,
including “ALL RIGHTS RESERVED”. No licence was supplied with the archive, and
IFTF's distribution rights have not been independently verified. This project
decision is not a new copyright licence. The
[provenance notice](../../third_party/colossal-cave/NOTICE.md) contains the exact
copyright text and links to the archive and foundation.

## Reproduce the image

Use an existing Triptych WASM host built by the normal procedure. The default
inputs are the pinned repository files in `third_party/colossal-cave/`; no
browser database or private workspace is required. Their source is
[Advent_CPM.zip](https://www.ifarchive.org/if-archive/games/cpm/Advent_CPM.zip)
with the archive SHA-256 recorded in the handoff:

```text
9a9feb501c15c728f1e4e88eda6de325f1270052a205c6f27dc86f3c8d4d492a
```

From the repository root, select a fresh output directory:

```sh
node tools/build-colossal-cave-image.mjs /path/to/output
node tools/prove-colossal-cave-image.mjs /path/to/output
```

For independently acquired inputs, verify that archive digest and extract
`Adventur.com` and `Phrogz.din`. The original two-argument interface remains:
`node tools/build-colossal-cave-image.mjs /path/to/input /path/to/output`.
Both forms enforce the same binary and image hashes.

The proof normally reads the built browser release's four-drive residents.
Alternatively, pass the `n04` artifact folder produced by
`npm run check:two-mib-system` as its second argument. It verifies the system
and bootstrap hashes against that folder's descriptor before starting a CPU.

The builder checks both input hashes, uses the existing `CpmDisk.create_two_mib`
and import routines, reopens the image, and verifies its directory and every
file byte. Different bytes under the same revision cause an error.
Neither input needs record padding or text conversion. No assembler is needed
to package these existing binaries.

The image is `colossal-cave-350-r1.img`: 2,097,152 bytes, SHA-256
`5dc331b1be3609cb72bb728d3f64b811d9aea95b8357c9cb3224d150596bad33`.
Its format is `triptych-cpm-2m-v1`: 128-byte records, 128 records per track,
128 tracks, one reserved track, 2,048-byte allocation blocks and 1,024 directory
entries. The reserved system area contains zeroes. See the
[format specification](../../docs/specifications/cpm-two-mib-v1.md).

| File         |   Bytes | SHA-256                                                            |
| ------------ | ------: | ------------------------------------------------------------------ |
| ADVENTUR.COM |  45,824 | `10cdb0b98c9c34bf75ccbf81416afd345e9f5a03c5a829361440cd7ade34cce2` |
| PHROGZ.DIN   | 113,792 | `1608f09301e81c3a092ce91a534828f4abede339a3ebbc30de9297c65f5b6e7f` |

`candidate.json` is a provenance record, not a new disk-library catalogue
schema. The human image label is `r1`; the published catalogue revision must be
the full image hash above, under ID `colossal-cave-350`. The data disk's
`systemProfile` is null: the matching system and bootstrap belong on A.
Integration uses the existing [library contract](../../docs/specifications/disk-library-v1.md)
and [release procedure](../../docs/disk-library-releases.md). Published-image
bytes remain immutable; played disks and saved executables belong to personal
storage. No separate URL recipe is defined here.

## Run and save

Use the matched `triptych-cpu-v0.1-2m-n04` system and bootstrap on A, a writable
work disk on B, and this software disk on C. From CP/M, enter `C:` then
`ADVENTUR`. Answer `NO` to skip the instructions. `ENTER`, `TAKE KEYS` and
`INVENTORY` exercise the first room; `QUIT`, then `YES`, returns to CP/M.

This version's `SAVE` command suspends the program and prints instructions for
a core-image save. It does not present a destination filename. After `SAVE`, `YES`, and the
return to `C>`, the tested four-drive recipe is:

```text
C>SAVE 224 B:SAVED.COM
C>B:SAVED
```

Keep C selected while invoking the saved executable on B, so its database
remains available on the current drive. The 224-page snapshot occupies 57,344
bytes and fits below this profile's CCP. This is a profile-specific tested
choice, not an upstream documented save size or a general recipe for other
memory maps. The game mentions a 90-minute delay; the tested saved executable
resumed immediately.

For the writable-template alternative, start from an independent copy of the
same image mounted writable on C. Save with `SAVE 224 SAVED.COM` and resume
with `SAVED`. Never replace the published seed with a played or saved copy.

## Qualification boundary

The repeatable proof runs an isolated WASM CPU with four drives and protected
system A. It checks
startup, room movement, inventory, suspension, file creation, restoration on a
fresh machine, retained inventory and quitting to CCP in both arrangements.
The protected arrangement uses the sector provider's write protection and
checks unchanged C bytes, including after an attempted CP/M write to C.
The writable arrangement verifies creation on C without changing B. Both
arrangements preserve A and spare D. Generated transcripts and
`qualification.json` identify the host and resident hashes used.

This does not qualify the entire adventure, native or ESP32 execution, a
hosted fetch, the library interface, or browser persistence. Distribution has
been authorised as recorded above; complete release and hosted qualification
remain separate requirements.

### Original isolated proof, 2026-09-12

Both arrangements passed the proof, including cold restoration and retained
keys. The explicit protected-disk write returned `Bdos Err On C: Bad Sector`;
no file appeared and the image remained byte-identical. This is the current
guest error presentation, not a friendly library-level read-only message.
Repeated builds produced the image hash recorded above.

The host WASM SHA-256 was
`3d609b19984daa965627a06a2a02cdeef4197450c12efd3c4e05ff433fb7a933`.
The N04 system hash was
`61dd21e3f89be888e3530ec3b414691c343f7ad2c29aa15fac4ff2510c3a5a3e`;
the bootstrap hash was
`54c6bfd356b4b42f8c51f3b85777a9d2be7aa680945335783c4dd7a6dae8921e`.
These were built against Triptych revision
`8a186e69f83a9c0cf324c6ef4f1bc29441f1d4ab` with existing uncommitted development
present. This is candidate evidence, not a clean release qualification.

Syntax, formatting and whitespace checks passed for the added tooling. A
complete repository check was started and stopped during browser tests after
another ongoing Triptych verification run was discovered. Its partial results
are not a full-suite pass. Existing image-library, site and build changes were
left intact; no catalogue entry, deployment or browser persistence change was
made by this candidate preparation.

### Repository-input recheck

The repository-owned inputs reproduced the same image hash twice. The adapted
proof passed both arrangements with protected A, including cold restoration,
retained keys, unchanged A/D and rejection of a write to protected C. The host
WASM hash for this recheck was
`14745cc0d98c6e516135d328979c2b2b7764ec4b82e17a14a0c1c4dc08330309`;
the system and bootstrap hashes match the original proof above. This remains
isolated guest evidence; it does not establish the library's hosted release.
