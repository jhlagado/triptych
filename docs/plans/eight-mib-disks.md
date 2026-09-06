# Eight MiB disks

Date: 2026-09-06. Status: active goal; one-drive foundations and browser migration
pass the complete local check. The two-drive controller/host proof also passes.
Multi-drive BDOS, resident profiles, browser drive sets and release qualification
remain.
Starting revision: `1589d7ebf9d2271a464446a1ff3039f68c6e02f3`.

The starting tree passed `npm run check`, including 48 browser tests, 287
TypeScript tests, native/WASM application parity and Rust workspace checks.
These are regression baseline results, not proof of large-disk support.

The [disk-profile contract](../specifications/cpm-disk-profiles-v1.md) records
the selected geometry. The [foundation report](../reports/eight-mib-foundation.md)
records the BIOS, image library, upstream bounds correction and native/WASM
application proofs. Those results do not constitute hosted browser acceptance.

Deliver larger logical disks in the browser and native hosts, beginning with one
drive and then adding independently selected drives. Existing saved disks and
their recovery backups must remain usable. This follows the completed
[browser development workspace](browser-development-workspace.md). Project ZIP
export remains a proposed follow-up, separate from this storage milestone.

## Scope and ownership

Triptych maintains the BIOS, disk profiles, host storage, image utilities and
browser migration. Portable CP/M maintains BDOS and CCP. Any BDOS correction
must be developed and tested in that repository, then consumed as a pinned
release; the retained Triptych source snapshot is not an independent OS fork.
ATOM remains the assembler for every production and test build.

The target is an 8 MiB logical image per drive. The selected profile must state
the exact image size, reserved system area, directory capacity and free file
space separately. An 8 MiB image does not provide 8 MiB of free file space.
The initial multi-drive acceptance target is A and B; the supported drive count
must be bounded by a measured resident-memory budget. Sixteen simultaneously
mounted drives are not assumed merely because CP/M has sixteen drive letters.

CPU ports, 128-byte logical records and the 512-byte backing-sector boundary
remain unchanged. Video, sound and physical ESP32 qualification are outside
this goal. No deployed disk is reformatted or adapted without an explicit,
backed-up operation.

## Inspection baseline

The current image library accepts the 256,256-byte IBM 3740 image and its
256,512-byte sector-padded form. Its allocation map has 243 one-KiB blocks and
64 directory entries. The BIOS exposes drive A and performs the fixed
26-record track conversion. These are small-floppy assumptions, not a 2 MiB
BDOS limit.

BDOS obtains geometry through BIOS DPH/DPB structures and already includes
two-byte allocation entries. Existing tests include a word-allocation read;
they do not qualify an 8 MiB filesystem. Block-address arithmetic, extent
transitions, allocation scans and failure paths need larger-boundary proofs.

The controller and native/WASM sector providers already have wider addresses
and multiple-drive interfaces. The browser coordinator and saved revision
currently contain one named disk. The browser file library contains fixed
geometry constants. These layers require separate changes.

The WASM provider currently copies the complete disk into its checkpoint on
every guest flush. The BIOS flushes after a record write. Capacity work must
therefore include a checkpoint-cost measurement and preserve the exact-flush
snapshot contract when reducing copying.

## Stages and acceptance

| Stage                        | Work                                                                                                    | Completion evidence                                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Profile and proof design  | Compare disk geometries, reserve BIOS work areas, define image identity and legacy detection.           | Reviewed profile arithmetic, non-overlapping memory map, explicit first/last/rejected addresses and independent design review.                                                               |
| 2. Shared image support      | Add named geometry to the Rust filesystem and native utility; create and migrate a new image privately. | Exact legacy round trips; large allocation entries; all supported users and attributes preserved; malformed, sparse or unsupported input fails without publication.                          |
| 3. Guest large-drive support | Implement the Triptych BIOS profile and qualify Portable CP/M BDOS.                                     | Guest reads and writes above 2 MiB and at the final allocatable block; extent rollover, random access, directory-full and disk-full tests; stack and workspace canaries; native/WASM parity. |
| 4. Browser integration       | Add explicit migration, geometry-aware Files and tool updates; qualify checkpoint performance.          | Backed-up migration, cancel and quota-failure preservation, reload/download/reopen, and ATOM/NUC/Edit build-and-run on the larger disk.                                                      |
| 5. Multiple drives           | Add independently selected media and a coherent saved drive set.                                        | A/B isolation, explicit-drive filenames, absent-drive errors, drive switching, warm boot, all-drive checkpoints and recovery after restart.                                                  |
| 6. Release qualification     | Combine independent reviews and regression results; retain recovery artifacts.                          | Full repository checks, Linux CI, browser acceptance on fresh and legacy profiles, and verified hosted assets before declaring the goal complete.                                            |

Stage 1 precedes changes to the persisted format and BIOS memory layout.
Stages 2 and 3 can run in parallel once the same profile is fixed. A checkpoint
implementation can be tested independently of the Files UI. Stage 4 integrates
those results; stage 5 requires another review of the multi-drive publication
boundary. Each combined implementation requires independent review and a fresh
complete regression run.

## Preservation and failure tests

Migration creates a freshly formatted candidate and copies logical files; it
does not enlarge an old image in place. Preserve record-rounded contents,
user numbers and file attributes. Reject any valid-but-unsupported structure
explicitly instead of skipping it. Keep the source image byte-for-byte as a
downloadable backup, including its old system records.

Normal reopening continues to install saved bytes exactly. New geometry and
resident-system adaptation must agree before a candidate becomes active.
Cancellation, validation failure, stale revisions and storage failures must
leave the preceding durable image and backups unchanged. Preparation uses a
fresh, unexecuted CPU and publishes only after the storage transaction commits.

Guest disk-full errors need precise, operation-specific assertions: CP/M may
have successfully written preceding records before the failing write. Tests
must distinguish those legitimate earlier writes from corruption of unrelated
files, allocation maps, return stacks or neighbouring drives. Host-side batch
installation and migration retain their stronger all-or-none publication rule.

Checkpoint tests must distinguish flushed sectors from later unflushed writes,
including several dirty sectors, repeated writes to one sector, clean flushes
and drive switches. Browser persistence must not publish an unflushed sector
merely because another drive completed a flush.

## Current next step

Qualify and correct upstream multi-drive BDOS semantics before selecting the
resident layout. Current source reinitializes the allocation vector on drive
reselection and does not select an explicit FCB drive. Tests must prove open-file
allocation preservation on A/B/A and explicit-drive access without changing the
default drive. The corrected resident byte count determines the next layout.

Portable CP/M 0.1.2 is published and pinned. The full local Triptych check passes
336 TypeScript tests, 59 browser tests, native/WASM application workflows and
Rust checks. The new controller proof executes 43 commands across two 8 MiB
images and 20 boundary reads after reopening, with exact image comparisons.
It does not establish multi-drive CP/M or browser drive-set behavior.

The [resident candidates](../reports/eight-mib-multiple-drive-memory.md) require
application compatibility qualification. Current tools use E400 stacks, but the
pinned CCP supplies a warm-boot return address. Test that explicit CCP-lifetime
overlap before requiring new tool releases or reducing their buffer capacities.
