# Two-MiB CP/M disks and configurable drives

Date: 2026-09-07. Status: implementation in progress; not release-qualified.
The user selected two-MiB images and two-KiB allocation blocks. Sixteen drives
are the supported maximum target; normal configurations have two or four.
Existing small-disk and eight-MiB profiles retain their current meanings.

The [implementation plan](../plans/two-mib-configurable-drives.md) defines the
gates. The [design report](../reports/two-mib-design.md) separates inspected
source, scratch assembly measurements and unproved implementation budgets.

## User configuration

A new machine selects a configured count from 1 through 16, with two and four
as the prominent presets. Count N configures the contiguous letters A through
the Nth letter. For example, four slots configure A–D; C and D may be empty. Sparse
inserted media are supported, but arbitrary sparse configured letter sets are
outside this version. Using P requires sixteen configured slots.

The interface reports configured slots, inserted media and the profile's COM
load capacity separately. All configured slots have allocation state even when
empty; unconfigured slots have none. A is mandatory boot media. Other slots are
independent data media, with reserved system areas that file operations preserve.

Changing the configured count is an explicit machine reconfiguration: checkpoint
and back up the complete preceding machine, install matching released residents
and bootstrap into a private candidate, publish it, then cold-boot. A failed or
cancelled operation preserves the preceding durable machine. Reducing the count
requires explicit treatment of every removed disk, with a complete backup and
an export opportunity; it must not silently discard those disks.

Insertion and ejection change media, not the configured count or TPA. The first
implementation uses checkpoint, backup and cold restart for these operations
too. Mounted media identity and external contents must not change while the
guest runs; native attachment requires an enforced ownership policy in addition
to path-alias checks. CKS zero relies on this lifecycle. A hot-swap protocol for live
FCBs is deferred. Ejecting a disk cannot safely
enlarge the memory of an already-running program: its resident addresses,
pointers, stacks and load boundary were established at launch.

## Disk format

Format identity: `triptych-cpm-2m-v1`. All configured guest media in this profile
use this exact geometry. Image length identifies a candidate format, not valid
directory contents or compatible resident software.

| Field                                   |             Value |
| --------------------------------------- | ----------------: |
| Raw and sector-padded image bytes       |         2,097,152 |
| Logical record bytes / count            |      128 / 16,384 |
| Records per track / tracks              |         128 / 128 |
| Reserved tracks (OFF) / system bytes    |        1 / 16,384 |
| Allocation block bytes / count          |     2,048 / 1,016 |
| Maximum block (DSM)                     |             1,015 |
| BSH / BLM / EXM                         |        4 / 15 / 0 |
| Directory entries / maximum entry (DRM) |     1,024 / 1,023 |
| Directory bytes / reserved blocks       |       32,768 / 16 |
| AL0 / AL1                               |           FF / FF |
| Check-vector bytes (CKS)                |                 0 |
| Allocation-vector bytes                 |               127 |
| Initially free file blocks / bytes      | 1,000 / 2,048,000 |

There is no trailing padding or unallocated gap. Directory records are 128–383;
ordinary file storage starts at record 384. Block 1,015 occupies records
16,368–16,383. Valid BIOS coordinates are track 0–127 and sector 1–128. Validate
both before computing `track * 128 + sector - 1`. Controller capacity is the
32-bit count 16,384; record 16,384 is already out of range.

Each directory entry contains eight little-endian 16-bit block references and
describes one 16-KiB logical extent. Entries and capacity are shared across all
sixteen CP/M user areas. Empty files consume an entry but no data block. A
nonempty file uses at least one two-KiB block; a partially used final block has
up to 2,047 bytes of allocation slack. Record-rounded exports remain unchanged.

A 1,024-entry directory permits 1,000 one-block files before data exhaustion.
A 512-entry alternative would save 16 KiB of disk space but exhaust directory
entries with roughly half the data area still free for that workload. The
selected directory requires no larger ALV or shared directory buffer. Longer
directory scans are a performance cost to measure. The directory-boundary tests
pass through a BIOS double; production-machine qualification remains separate.

## Resident profile family

Named identities are `triptych-cpu-v0.1-2m-n01` through
`triptych-cpu-v0.1-2m-n16`. One parameterized source family produces immutable,
release-identified artifacts for every count. The browser selects artifacts;
it does not assemble or relocate residents at runtime. Odd/even count pairs
share origins but have different configured-count and table identities.

For N configured slots:

```text
allocation reservation = 256 * ceil(N / 2)
allocation base        = 0x10000 - allocation reservation
BIOS base              = allocation base - 0x0400
BDOS base              = BIOS base - 0x0E00
CCP base               = BDOS base - 0x0800
COM load interval      = [0x0100, CCP base)
allocation slot i      = allocation base + 128 * i, for 0 <= i < N
```

The first 127 bytes of each slot are its live ALV; byte 127 is a guard. Odd
counts leave one unused 128-byte half-page after the configured slots. This
alignment space is real reserved memory, not an additional configured drive.

| Slots | CCP base | BDOS base | BIOS base | ALV reservation | COM load bytes |
| ----- | -------- | --------- | --------- | --------------- | -------------: |
| 1–2   | E500     | ED00      | FB00      | FF00–FFFF       |         58,368 |
| 3–4   | E400     | EC00      | FA00      | FE00–FFFF       |         58,112 |
| 5–6   | E300     | EB00      | F900      | FD00–FFFF       |         57,856 |
| 7–8   | E200     | EA00      | F800      | FC00–FFFF       |         57,600 |
| 9–10  | E100     | E900      | F700      | FB00–FFFF       |         57,344 |
| 11–12 | E000     | E800      | F600      | FA00–FFFF       |         57,088 |
| 13–14 | DF00     | E700      | F500      | F900–FFFF       |         56,832 |
| 15–16 | DE00     | E600      | F400      | F800–FFFF       |         56,576 |

CCP occupies 2,048 bytes, BDOS 3,584, and BIOS 1,024. These capacities include
their code, data and stacks. Page zero occupies another 256 bytes. The COM
figures are load ceilings, not guarantees of arbitrary application runtime use.

| Configured slots | Live ALVs | DPH tables | ALV guards | Drive-specific bytes | Entire high-memory reservation |
| ---------------: | --------: | ---------: | ---------: | -------------------: | -----------------------------: |
|                2 |       254 |         32 |          2 |                  288 |                          6,912 |
|                4 |       508 |         64 |          4 |                  576 |                          7,168 |
|               16 |     2,032 |        256 |         16 |                2,304 |                          8,704 |

The 16-byte DPH per drive is inside the BIOS reservation; do not add it twice.
The BIOS also includes a shared 15-byte DPB, 128-byte directory buffer, 32-byte
boot stack, code and other state. CCP's 48-byte stack and BDOS's 64-byte stack
are already inside their slots. The often quoted 127/128 bytes is allocation
tracking per drive, not total overhead. The sixteen-slot profile loses 1,792
COM-load bytes relative to the two-slot profile, including layout effects.

The BIOS budget is explicit: common code and shared state must fit in its first
768 bytes; the last 256 bytes contain exactly N DPHs followed by padding. Only
configured DPHs and ALVs are live. Fixed BIOS headroom and page alignment mean
that reducing the count does not always enlarge TPA. In particular, removing
one slot from an even count changes bookkeeping but not that pair's origins.

Current A/B BIOS common storage occupies 705 bytes after subtracting its two
DPHs. The new common-code budget therefore permits 63 bytes of growth. This is
the original feasibility budget. The scratch generalized BIOS measures 723
common bytes, leaving 45 bytes. Production builds must enforce the same size
gate; no silent change of origins, disk size, drive maximum or advertised TPA
is permitted.

## Tool and boot lifetime

The smallest-TPA profile keeps BDOS at E600, above the tools' E400 private stacks.
Those stacks may overwrite dead CCP bytes after launch, but never live BDOS,
BIOS, allocation state or the saved incoming return word. Warm boot restores
CCP before command processing. No arbitrary COM is granted a general right to
overwrite residents.

Scratch builds of the current CCP place the launch word at ECEB for two slots,
EBEB for four, and E5EB for sixteen. These are measured locations for that
source, not fixed ABI constants. Tests must derive them from assembled symbols
and inspect exact SP and return PC on success, failure, capacity errors and
generated Nucleus traps. A load-size test alone is insufficient. Existing tool
buffers do not automatically grow when a profile has more free memory.

Cold boot loads 52 system records from A into the selected CCP base and enters
the corresponding BIOS. Warm boot reloads the 44 CCP/BDOS records only. Boot
scratch addresses and overlay-exit code are profile-relative and must remain
outside both the incoming image and live execution. All boot workspaces require
explicit initialization; RAM contents after machine reset are unspecified.

Every configured drive has a distinct stable DPH and ALV. Geometry and the
directory buffer are shared; open-file allocation reservations are not. BIOS
selection validates configured index, presence and exact record count before
publishing a new logical binding. Invalid coordinates issue no record I/O.

Warm boot flushes every present configured drive, including wrong-size media
that direct controller operations could have dirtied, before reading residents
from A. Supported launchers expose no media outside the configured range. Any
flush failure stops reload. Earlier successful checkpoints may remain durable
when a later drive fails; this sequence is not a multi-drive transaction.
Default-drive P must survive a successful warm boot when P is available.

## Ownership and compatibility

Triptych owns the format, machine profiles, BIOS, bootstrap, image tools,
launchers, browser UI and persistence. Portable CP/M owns parameterized CCP and
BDOS builds and their public-interface tests. ATOM, Nucleus and Edit retain
independent source and release ownership. Any tool correction belongs upstream;
Triptych must not patch installed COM files. All assembly uses ATOM. Production
code and firmware have no Debug80 dependency.

Preserve the existing IBM 3740 and eight-MiB formats, matching bootstrap/resident
profiles and recovery readers. They remain usable as separate configurations;
this new profile does not claim mixed-capacity guest mounting. Merely opening
saved media never selects new geometry, installs residents or updates tools.

Two operations remain distinct:

- Format migration constructs new two-MiB images and copies every supported
  user's logical files, attributes and record-rounded bytes. Malformed, sparse
  or non-fitting input rejects the complete candidate; no truncation or skipped
  files. Preserve the complete original machine and raw images as a backup.
- Resident reconfiguration keeps filesystem bytes unchanged and replaces only
  A's identified resident payload, its matching bootstrap and configured count.
  Preserve the unused reserved-area tail and all other media exactly. Neither
  operation implies a tool update.

## Saved-machine representation

Use a new versioned drive-set format, rather than changing v3's A/B meaning.
The v4 semantic value has a resident profile, exact bootstrap, configured count
and an ordered array of exactly N nullable media slots. Array index is the guest
drive number; there is no second letter-to-index mapping. A must be present.
Each inserted medium retains a stable logical media-instance ID, name, exact
length and immutable content hash. Instance IDs are unique within an active
machine and survive checkpoints and reconfiguration. Creating or independently
importing another disk creates another instance; retained backups may refer to
the same historical instance. The configured count must match the identified
bootstrap/resident profile.

Independent media may have identical names and contents, including blank disks.
Immutable blobs may be deduplicated by content hash, but a write replaces only
the selected instance's blob reference. Never alias their writable state.
Reject mounting one writable backing object twice, including native path or
inode aliases; byte equality alone is not an alias or an error.

Continue decoding v1/v2/v3 and existing `.tds` archives. Retain their source
records and raw recovery export when normal interpretation fails. A new v4
manifest and archive version must reject mismatched counts, duplicate active
media-instance IDs,
unknown profiles, bad lengths/hashes and unsupported versions before publication.
Freeze its byte framing and transaction tests before its first writer is added.

Use immutable media blobs and a compare-and-swap head for complete configurations,
with bounded checkpoint coordination. Per-drive successful flushes publish only
that drive's acknowledged bytes, never another drive's unflushed work. Format or
count changes publish the entire private candidate and preceding backup together.
Quota failure, stale revisions, cancellation and interrupted transactions retain
the previous durable state; recovery must not seed over unrecognized data.

Sixteen inserted images contain 32 MiB of host data. Current WASM working and
checkpoint arrays alone would consume about 64 MiB, before browser copies,
archives and metadata. That is host memory, not Z80 RAM, and requires separate
measurement. It is not a suitable assumption for an ESP32 implementation with
eight MiB of PSRAM; its future SD provider must use bounded caching.
