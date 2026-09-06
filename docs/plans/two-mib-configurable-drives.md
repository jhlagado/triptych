# Two-MiB configurable-drive roadmap

Date: 2026-09-07. Status: scratch BIOS feasibility and initial Portable CP/M
interface tests passed; production implementation is in progress.

The user selected two-MiB disks with two-KiB blocks. The target is a configurable
one-to-sixteen-slot machine, normally two or four slots, with independent A–P
support at the maximum. The [selected design](../specifications/cpm-two-mib-v1.md)
fixes geometry, memory accounting and preservation rules. The
[design report](../reports/two-mib-design.md) records the evidence and remaining
feasibility gate. This direction replaces eight-MiB expansion as the next work;
existing functionality, safety fixes and saved media remain supported.

## First milestone

Prove a one-KiB generalized BIOS and the selected resident layouts in disposable
host fixtures before implementing browser changes. Start with the maximum count
to expose the memory constraint, then prove count bounds 1–16. A working two-slot
prototype is an intermediate result, not permission to drop sixteen-slot support.

The scratch BIOS uses 723 of its 768 common bytes, leaving 45 bytes. Production
builds must enforce that cap. If they cannot fit, report the excess and revise the layout
explicitly while preserving the selected disk size and maximum-drive target.
No existing profile or saved disk should change to make a test pass.

## Stages and evidence

| Stage                    | Work and owner                                        | Acceptance                                                                                                                                                                                                                                               |
| ------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Layout feasibility    | Triptych BIOS/bootstrap; Portable CP/M named origins  | ATOM-assembled code, tables and stacks fit every declared slot; exactly N distinct DPHs/ALVs; odd-count padding and all guards checked; cold-load and warm-reload intervals exact.                                                                       |
| 2a. Filesystem format    | Triptych image library and native utility             | Exact DPB and 2,097,152-byte geometry; block 255/256/1,015; entries 255/256/511/512/1,023; all users, attributes and empty files; capacity failures leave source unchanged; legacy/eight-MiB round trips.                                                |
| 2b. Guest OS contract    | Portable CP/M                                         | Sixteen simultaneously live drive bindings and open-file reservations; logged/read-only/reset masks across bits 7/8/15; explicit P FCBs; full volume and full directory while data remains free; delete/reuse and reload reconstruction.                 |
| 2c. Persistence contract | Triptych host/browser design and isolated tests       | Freeze v4 manifest/archive framing, identity rules, old-format readers and atomic head/backup transactions before adding a writer.                                                                                                                       |
| 3. Native/WASM machine   | Triptych                                              | A–P interleaved operations, missing A, configured-empty and wrong-size media, invalid drive 16, sparse inserted slots, default P warm boot; first/middle/final flush faults; exact images and fresh-host reopening.                                      |
| 4. Tools and limits      | Triptych integration; fixes only in tool owners       | Every released layout passes loader and tool control-flow tests; complete ATOM/NUC/Edit arenas at smallest TPA and every distinct liveness case; symbol-derived incoming word, stack, trap, return and reload checks.                                    |
| 5. User configuration    | Triptych browser and native launcher                  | Select 2/4/16 and other supported counts; configured versus inserted state visible; count changes and insertion/ejection use backup/reboot; downsize rejects non-fitting data; removed media retained; complete sixteen-drive archive and restart proof. |
| 6. Stable release        | Each owner qualifies its release; Triptych integrates | Full checks, independent adversarial review, pinned component and profile identities, Linux CI, actual hosted tests, permanently retained and redownload-verified recovery artifacts.                                                                    |

Stage 1 settles the resident-size gate before broad implementation. Stages 2a,
2b and 2c can run independently against the same contract. Stage 3 integrates
2a/2b; stage 4 follows actual resident execution. Persistence work can proceed
beside them, but stage 5 requires both machine and persistence proofs. Stage 6
uses one coordinated build and publication, with independent review of evidence.

## Reconfiguration acceptance workflow

A user creates a four-slot machine, inserts A and B, edits and compiles a program,
then configures sixteen slots. The operation shows the changed application-memory
limit, retains the preceding complete machine, installs the identified resident
tuple and reboots. The same program and files work on P, survive checkpoint and
reload, and remain isolated from A.

Reducing to two slots must not discard C–P. A failed export, full target disk,
stale publisher or failed backup publication leaves the sixteen-slot machine
durable and recoverable. A successful explicit reduction retains the complete
old archive and displays the new load limit after reboot. Ejecting B while two
slots remain configured does not advertise additional application RAM.

Old small and eight-MiB sessions reopen with their original resident identities.
No new browser deployment converts their disks merely because a preferred
two-MiB profile exists. Keep exact recovery available even for malformed media
that cannot be migrated by filename.

## Scope boundaries

This plan authorizes no destructive rollback or automatic migration. Do not
remove existing safety improvements or downgrade IndexedDB to an old website's
schema. Preserve component ownership and instruction-file deletions; only
human-facing project documents belong in the repositories.

Desktop/browser memory and save latency are measured separately from guest RAM.
Include a full sixteen-disk payload, queued-save bound, unchanged-blob reuse,
archive creation, directory-scan cost and failure recovery. Report measured
values, not a host-memory guarantee extrapolated from ALV sizes.

ESP32 SD caching and physical power-loss behavior remain later hardware work.
Video, sound, bank switching, live hot swap and project ZIP export are outside
this profile milestone. No browser or native proof establishes hardware timing.
