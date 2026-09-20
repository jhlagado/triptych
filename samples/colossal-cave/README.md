# Colossal Cave disk candidate

This recipe prepares the IF Archive's two-file 350-point Adventure for
Triptych's four-drive, two-MiB CP/M profile. It creates a data disk, not a boot
disk. Both original files remain byte-for-byte intact; only their names become
uppercase CP/M names.

This candidate is **not approved for public redistribution**. `ADVENTUR.COM`
contains a 1977 Small System Services, Inc. copyright notice with all rights
reserved. The downloaded archive contains no licence. Keep generated binaries
outside the repository and deployed site until permission for this particular
distribution is established. Availability in a public archive is not a grant.

## Reproduce the candidate

Build Triptych's WASM host using its normal build procedure. Download
[Advent_CPM.zip](https://www.ifarchive.org/if-archive/games/cpm/Advent_CPM.zip)
and verify the archive SHA-256:

```text
9a9feb501c15c728f1e4e88eda6de325f1270052a205c6f27dc86f3c8d4d492a
```

Extract `Adventur.com` and `Phrogz.din` into an input folder. From the repository
root, run the following with paths to your input and private output folders:

```sh
node tools/build-colossal-cave-image.mjs /path/to/input /path/to/output
node tools/prove-colossal-cave-image.mjs /path/to/output
```

The proof normally reads the built browser release's four-drive residents.
Alternatively, pass the `n04` artifact folder produced by
`npm run check:two-mib-system` as its second argument. It verifies the system
and bootstrap hashes against that folder's descriptor before starting a CPU.

The builder checks both input hashes, uses the existing `CpmDisk.create_two_mib`
and import routines, reopens the image, and verifies its directory and every
file byte. It refuses to replace different bytes under the same revision.
Neither input needs record padding or text conversion. No assembler is needed
to package these existing binaries.

The image is `colossal-cave-350-r1.img`: 2,097,152 bytes, SHA-256
`5dc331b1be3609cb72bb728d3f64b811d9aea95b8357c9cb3224d150596bad33`.
Its format is `triptych-cpm-2m-v1`: 128-byte records, 128 records per track,
128 tracks, one reserved track, 2,048-byte allocation blocks and 1,024 directory
entries. The reserved system area contains zeroes. See the
[format specification](../../docs/specifications/cpm-two-mib-v1.md).

| File         |   Bytes | Purpose                     |
| ------------ | ------: | --------------------------- |
| ADVENTUR.COM |  45,824 | Z80 CP/M executable         |
| PHROGZ.DIN   | 113,792 | Required adventure database |

`candidate.json` is an investigation record, **not a new disk-library catalogue
schema**. When publication is cleared, translate its facts into the library
interface agreed by the [ongoing implementation](../../docs/plans/disk-library-and-launch-links.md).
Copy the immutable revision asset into the site's release output and verify
its downloaded bytes before offering a launch link. No URL recipe is defined
here, and no browser database is read or modified.

## Run and save

Use the matched `triptych-cpu-v0.1-2m-n04` system and bootstrap on A, a writable
work disk on B, and this software disk on C. From CP/M, enter `C:` then
`ADVENTUR`. Answer `NO` to skip the instructions. `ENTER`, `TAKE KEYS` and
`INVENTORY` exercise the first room; `QUIT`, then `YES`, returns to CP/M.

This version's `SAVE` command suspends the program and asks for a core-image
save. It does not present a destination filename. After `SAVE`, `YES`, and the
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

The repeatable proof runs an isolated WASM CPU with four drives. It checks
startup, room movement, inventory, suspension, file creation, restoration on a
fresh machine, retained inventory and quitting to CCP in both arrangements.
The protected arrangement uses the sector provider's write protection and
checks unchanged C bytes, including after an attempted CP/M write to C.
The writable arrangement verifies creation on C. Generated transcripts and
`qualification.json` identify the host and resident hashes used.

This does not qualify the entire adventure, native or ESP32 execution, a
hosted fetch, the future library catalogue, or browser persistence. Public
release also remains dependent on redistribution permission. These two mount
arrangements provide candidate tests; they are not two published, fully
qualified library examples yet.

### Measured on 2026-09-12

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
