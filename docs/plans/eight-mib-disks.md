# Eight MiB disks

Date: 2026-09-06. Status: active goal; one-drive foundations and browser migration
pass the complete local check. The separately pinned A/B residents and basic
native/WASM tool workflows now pass the complete local check. Full-volume BDOS
and actual machine storage-failure tests pass. Browser drive sets pass local
acceptance. Remaining tool-arena proofs and complete release qualification remain.
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

Portable CP/M 0.1.3 is published after 361 tests and independent release review.
It corrects multi-drive selection, queries and allocation reset. Triptych retains
its separately named E300/EB00 A/B artifacts under a new resident lock; the
default 0.1.2 release inputs remain unchanged. The implemented F900 BIOS has
737 live bytes and leaves separate allocation vectors at FC00 and FE00.

The retained-release A/B proof passes 30 native/WASM checkpoints and 12 COM
lifetimes, including explicit drive access, B editing and compilation, exact
load limits and fresh reopen. It checks full image and console parity, the saved
launch word, actual return PC/SP and resident reload before CCP entry.

Genuine full-volume allocation and actual backing-store/checkpoint failures
during warm boot now pass separate interface and machine tests. The complete
Triptych gate passes 378 Vitest cases, 59 browser cases, host workflows and Rust
checks. Persistent native reopening preserves existing system bytes and selects
its bootstrap profile explicitly; a fresh creator publishes new media separately.
The [A/B integration report](../reports/eight-mib-ab-integration.md) records the
release identities, execution measurements and proof limits.

The [storage and native-B report](../reports/eight-mib-drive-set-storage.md)
records the next local checkpoint: native B attachment, source/output/text
capacity and generated-failure paths, plus the standalone browser drive-set
codec and transaction store. The complete check passed 392 code tests and
80 browser tests; a subsequent focused run passed all 22 storage cases.

The [browser integration report](../reports/eight-mib-browser-ab.md) records the
subsequent complete-set coordinator, verified A/B assets and selected-drive UI.
Focused browser proofs now cover B tool workflows, backup/archive restoration,
both partial-flush directions, malformed saved state and delayed drive switches.
The combined check passed 459 code tests, 90 browser cases and all 34 headless
scenarios, together with native/WASM workflows and Rust checks. The report also
records measured browser storage latency and retained checkpoint memory, without
claiming full-page peak memory. Additional tool-arena qualification, new-revision
Linux CI and hosted release/recovery qualification remain open.

The earlier one-drive foundation pinned Portable CP/M 0.1.2 and passed
336 TypeScript tests, 59 browser tests, native/WASM application workflows and
Rust checks. Its controller proof executes 43 commands across two 8 MiB
images and 20 boundary reads after reopening, with exact image comparisons.
It does not establish multi-drive CP/M or browser drive-set behavior.

The [resident candidates](../reports/eight-mib-multiple-drive-memory.md) retain
the earlier alternatives and constraints. Basic E400-stack lifetime tests now
pass under the selected E300 profile; full capacity qualification is still
required before declaring the combined milestone complete.
