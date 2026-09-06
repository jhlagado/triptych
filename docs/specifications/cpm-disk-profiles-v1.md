# CP/M disk profiles v1

Status: selected implementation contract, 2026-09-06. One-drive host execution
has passed; release qualification remains pending. The existing IBM 3740 release remains the
default until the acceptance gates pass.

## Formats

Images contain raw 128-byte records. A supported byte length identifies a
format candidate, not valid directory contents or compatible resident software.
File operations validate all directory entries and allocation references.
Whole-image recovery retains exact bytes even when file interpretation fails.

| Field                         | `ibm3740` | `triptych-cpm-8m-v1` |
| ----------------------------- | --------- | -------------------- |
| Logical image bytes           | 256,256   | 8,388,608            |
| Sector-padded image bytes     | 256,512   | 8,388,608            |
| Logical record count          | 2,002     | 65,536               |
| Records per track (SPT)       | 26        | 128                  |
| Track count                   | 77        | 512                  |
| Reserved tracks (OFF)         | 2         | 1                    |
| System area bytes             | 6,656     | 16,384               |
| Allocation block bytes        | 1,024     | 2,048                |
| BSH / BLM / EXM               | 3 / 7 / 0 | 4 / 15 / 0           |
| Maximum block (DSM)           | 242       | 4,087                |
| Maximum directory entry (DRM) | 63        | 511                  |
| Directory bytes               | 2,048     | 16,384               |
| Reserved directory blocks     | 2         | 8                    |
| AL0 / AL1                     | C0 / 00   | FF / 00              |
| Check-vector bytes (CKS)      | 16        | 0                    |
| Allocation-vector bytes       | 31        | 511                  |
| Initially free file bytes     | 246,784   | 8,355,840            |

The large format has eight little-endian 16-bit allocation references per
directory entry. Each entry describes one 16 KiB logical extent, with at most
128 records. The legacy format has sixteen one-byte allocation references.
EXM is zero in both profiles. Other geometries and extent-packing schemes are
unsupported; they must not be guessed from a partially plausible directory.

The legacy final six records and padding are outside its allocation area.
Preserve them during ordinary file edits. The large image has no trailing
padding or unallocated gap: its last block ends at the last physical record.

## Address boundaries

For the large format, directory records begin at 128 and ordinary file storage
begins at 256. Block 4,087 occupies physical records 65,520 through 65,535.
Valid BIOS tracks are 0 through 511 and sectors are 1 through 128. Validate
both fields before computing `track * 128 + sector - 1`; invalid inputs return
disk error without issuing a record read or write.

The controller capacity is the 32-bit value 65,536 (`00010000` hexadecimal).
It is a count, not the last valid address. Do not truncate it into a 16-bit zero.
The largest allocation-relative record is 65,407, within BDOS's current 16-bit
arithmetic. Tests must distinguish block 255 from 256 and the last legal block
from an out-of-range block before any allocation-vector access or disk I/O.

## First resident profile

The first large-drive resident profile is `triptych-cpu-v0.1-8m-a`. Its BIOS
keeps the current CCP at E400, BDOS at EC00 and
loaded BIOS at FA00 through FDFF. The bootstrap still loads records 0 through
51; the remainder of the reserved track is not another filesystem area.

Reserve FE00 through FFFE for one 511-byte allocation vector. FFFF is outside
the vector and remains available as a test guard. These runtime bytes are
initialized during disk login, not loaded from the BIOS artifact. The assembled
BIOS code, tables, directory buffer and boot stack must fit below FE00.
The TPA remains 0100 through E3FF.

This is a one-drive profile. Additional independently resident allocation
vectors require a separately specified memory layout and application-capacity
qualification. The logical disk format remains the same when resident addresses
change. Disk format, resident profile, component release and saved revision are
distinct identities.

## Migration and publication

Migration builds a new image under an explicit target format and installs
matching resident system records. Copy every supported user's logical files,
their record-rounded bytes and attributes. Unsupported or malformed input
aborts the candidate operation; it does not skip files. Preserve the original
whole image and its old system bytes as a recovery backup.

Opening an existing saved image does not perform migration. Browser publication
uses the guarded pause, checkpoint, private candidate, revision comparison and
backup transaction described in the
[disk roadmap](../plans/eight-mib-disks.md). Native creation must refuse an
existing destination unless an explicitly supported replacement operation was
requested.

The browser deployment identifies this profile independently of the default
small-disk distribution. Its `diskProfiles` descriptor binds the format and
resident identifiers, drive count, image and system-area sizes, bootstrap and
CCP/BDOS hashes, and large BIOS source and binary hashes. The asset
`system-triptych-cpm-8m-v1.bin` contains exactly 16,384 bytes: the released CCP
and BDOS, the large BIOS, then zeroed reserved space after byte 6,655. Its length
and SHA-256 are also included in the deployment asset list. Client verification
compares the loaded residents and downloaded slots before staging a candidate.

An upgrade requires no other staged changes. Apply publishes the complete
candidate and exact preceding image through the existing backup transaction;
cancel or validation failure leaves the preceding image intact. Explicit
adaptation of an already-large imported image replaces only its first 6,656
resident bytes and preserves the rest, including reserved-tail bytes. Unknown
geometries reject adaptation but remain available for exact whole-image recovery.

## Design selection

Two independent proposals used 2 KiB blocks and EXM zero. The selected proposal
uses 128 records per track and 512 directory entries. Its power-of-two address
conversion is short, its full data range fits the existing relative-record
arithmetic, and its allocation vector leaves a guard byte in the top workspace.
The alternative uses 32 records per track and 1,024 directory entries, consuming
more directory space and requiring more track-division iterations. The first
profile retains enough extent entries to allocate its full file-storage area.

Retain the second proposal's separation of format, resident and saved-revision
identity, and its dirty-sector checkpoint approach. Defer its multi-drive
storage-schema proposal to the multi-drive design gate. The selected geometry
was checked against source arithmetic and then qualified through the BIOS and
filesystem execution tests recorded in the foundation report.
