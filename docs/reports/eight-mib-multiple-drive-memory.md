# Memory candidates for multiple 8 MiB drives

Date: 2026-09-06. Design candidates, not a selected multi-drive profile.
The initial arithmetic below has been extended by isolated ATOM prototypes and
source-level lifetime analysis. Corrected upstream BDOS behavior must be measured
before final placement. The [disk-profile contract](../specifications/cpm-disk-profiles-v1.md)
continues to specify one drive.

## Resident placement

Each 8 MiB drive needs a separate 511-byte allocation vector (ALV). With each
vector in a 512-byte slot, the final byte can be a corruption guard. The current
BIOS includes its directory buffer and boot stack inside its 1,024-byte loaded
partition; those work areas need not consume another slot above it.

The initial qualification candidate was two drives with CCP at E200, BDOS at EA00,
and BIOS at F800. ALV A occupies FC00–FDFE and ALV B occupies FE00–FFFE, with
guards at FDFF and FFFF. This costs 512 bytes of transient program area (TPA)
relative to the current E400 CCP placement.

| Candidate        | CCP  | BDOS | BIOS | ALV slot bases         | TPA reduction |
| ---------------- | ---- | ---- | ---- | ---------------------- | ------------: |
| Compact A–B      | E200 | EA00 | F800 | FC00, FE00             |     512 bytes |
| Conservative A–B | E000 | E800 | F600 | FA00, FC00             |   1,024 bytes |
| Compact A–D      | DE00 | E600 | F400 | F800, FA00, FC00, FE00 |   1,536 bytes |
| Conservative A–D | DC00 | E400 | F200 | F600, F800, FA00, FC00 |   2,048 bytes |

The compact placements put all ALVs above the loaded BIOS partition. They are
not a proof of the smallest possible packing inside BIOS padding. Their size
gate is whether the additional DPHs, drive-selection code and state still fit
the 1 KiB BIOS partition. The conservative placements leave another 512 bytes
above the BIOS. Neither drive count is a commitment to sixteen drives.

## Released tool constraints

The revisions below are the application pins in
[components.lock.json](../../distribution/components.lock.json) at inspection.
Source was read at those exact revisions, including remote retrieval of the
Edit revision absent from the local checkout. Uncommitted Nucleus source was
excluded.

- ATOM `802b5c2d320bec777f427755ff2d7338e3b80a05`:
  [native/cpm22-adapter.asm](https://github.com/jhlagado/atom/blob/802b5c2d320bec777f427755ff2d7338e3b80a05/native/cpm22-adapter.asm)
  sets output storage to 9000–D77F and SP to E400. The
  [CP/M memory census](https://github.com/jhlagado/atom/blob/802b5c2d320bec777f427755ff2d7338e3b80a05/proofs/cpm22-census.json)
  reserves a 3,072-byte stack; its representative 32-byte high-water mark is
  not a worst-case bound.
- NUC `b5276a85fd36600a10dbd65039f0af3afc033f0d`:
  [cpm22-target-memory-map.asmi](https://github.com/jhlagado/nucleus/blob/b5276a85fd36600a10dbd65039f0af3afc033f0d/asm/vertical-slice/cpm22-target-memory-map.asmi)
  places its output candidate at 7800–D4FF and its 3,840-byte stack at
  D500–E3FF. `cpm22-native-startup-code.asm` loads SP from STACKTOP.
- EDIT `2427501773e8d158d556631b8a4ba1cb972fcb4a`:
  [editor-memory.asmi](https://github.com/jhlagado/edit/blob/2427501773e8d158d556631b8a4ba1cb972fcb4a/src/editor-memory.asmi)
  places text at 2000–D7FF and its 3,072-byte stack at D800–E3FF.
  `editor-main.asm` loads SP from EditorStackTop.

All three released binaries would write stack data into the lowered CCP region.
That does not by itself prove incompatibility: the pinned CCP launches programs
with a warm-boot return address, so its low code can be dead during a transient.
The lifetime analysis below therefore precedes any requirement for new tool
releases. COM file sizes alone also do not establish compatibility.

If the selected profile prohibits CCP overlap, new tool profiles must move both
stack bounds and adjacent buffer ceilings down by the TPA reduction, preserving
stack capacity.
For E200, that means ATOM output end D580 and stack D600–E1FF; NUC output end
D300 and stack D300–E1FF; EDIT text end D600 and stack D600–E1FF. Buffer ends
are exclusive.

| Capacity                   | Current E400 | Proposed E200 |
| -------------------------- | -----------: | ------------: |
| ATOM output                |       18,304 |        17,792 |
| NUC output candidate       |       23,808 |        23,296 |
| NUC writable target region |        3,328 |         2,816 |
| EDIT text                  |       47,104 |        46,592 |

NUC derives its writable target ceiling from the output capacity, so its target
descriptor must change too. Its generated
[program provider](https://github.com/jhlagado/nucleus/blob/b5276a85fd36600a10dbd65039f0af3afc033f0d/asm/vertical-slice/cpm22-program-provider.asm)
uses low fixed addresses and the caller's stack, not an E400 stack reset.
Generated-program stack and return-path tests remain required.

## Boot and drive-selection changes

Portable CP/M's
[target-profile mechanism](https://github.com/jhlagado/portable-cpm/blob/b07dad632e7ef3be6528289a5a35308983964b05/tools/lib/target-profiles.mjs)
accepts page-aligned CCP origins and derives the contiguous 2,048-byte CCP,
3,584-byte BDOS and 1,024-byte BIOS reservations. Its source receives ordinary
ATOM EQU constants. New named profiles should retain that mechanism and the
default-profile byte checks; the selected large-disk BDOS correction remains a
separate release prerequisite.

The [ROM bootstrap](../../roms/cpu/bootstrap.asm) also needs a named placement.
It currently uses SYSBASE=E400, BIOSBASE=FA00, stack/stub E300, and counters
E2F0/E2F1. Changing only the load and entry addresses would leave bootstrap
scratch inside the lower resident image. Deriving stack/stub from CCP−100 and
counters from CCP−110/CCP−10F preserves their relative separation. The cold
load remains 52 records and warm reload 44 while the component sizes stay fixed.

In the [one-drive BIOS](../../system/cpm/bios-8m.asm), SELDSK accepts only A,
and SELADDR selects controller drive zero on every transfer. Multi-drive code
must validate the requested drive and exact 65,536-record capacity, return its
DPH, retain the selected drive and use it for later I/O. Each DPH needs a
distinct ALV; the immutable DPB can be shared for identical geometries. BDOS
must continue to initialize and rebuild allocations through the public BIOS
tables. Cold and warm boot still load system records from A.

## Qualification before selection

Required evidence includes assembled partition sizes; disjoint ALV, directory
buffer and stack ranges; cold boot and warm boot from B; absent, wrong-sized and
unsupported-drive rejection; and interleaved allocation/deletion with different
files on each drive. Last-block writes and guard checks must prove that an
operation on one drive leaves the other image and ALV unchanged.

Tool qualification must exercise maximum admitted buffers, capacity failures,
nested compilation, save/reopen and stack/resident canaries on both CPU
implementations. Browser and native recovery also need independent drive
identities and saved revisions. This report supplies no drive-selection,
multi-drive persistence or hardware execution proof.

Keep existing published images exact and require explicit migration to a new
resident combination. Copying old tool files is insufficient compatibility
evidence; their complete runtime and return paths must pass under that profile.
Any required tool replacement needs its own identified release and preserved
original bytes; disk format, resident profile, tool release and saved revision
remain separate identities.

## Subsequent candidate evidence

Fresh assembly of the pinned residents found 2,029 live CCP bytes, 3,490 live
BDOS bytes and 664 live one-drive BIOS bytes. Adding two 511-byte ALVs exceeds
the 7,168 bytes above E400 by 37 bytes, before a second DPH or drive-selection
code. Simple rearrangement cannot fit that baseline.

An isolated packed E400 prototype reduced the BIOS live account to 598 bytes,
including its directory buffer. It used all 94 bytes of the pinned BDOS tail for
BIOS tables, state and routines. A WASM smoke session passed separate A/B SAVE
and DIR commands and a COM return through warm boot. This is not an admissible
release composition: Portable CP/M currently owns the entire BDOS artifact,
including its padding. An explicit upstream reservation and composite artifact
identity would be required. Pending BDOS corrections also consume that space.

An alternative E300 prototype assembled a 694-byte two-drive BIOS beginning at
F900 and ending at FBB6. ALVs at FC00 and FE00 leave 74 bytes of live-BIOS
headroom before the first vector. Its 1,024-byte BIOS artifact includes cold-load
padding at FC00–FCFF; later ALV initialization may overwrite only those dead
padding bytes. Warm reload ends at F900 and leaves both ALVs untouched.
This is assembly evidence, not multi-drive execution qualification.

The E300 candidate keeps CCP at E300 and BDOS at EB00; bootstrap stub/SP move to
E200 and counters to E1F0/E1F1. It avoids placing BIOS content inside the BDOS
artifact. The final resident capacity remains conditional on the complete BDOS
drive-state correction, not only the current source census.

## Released-tool lifetime qualification

Exact pinned ATOM, NUC and Edit entry wrappers save their incoming SP, install
their own E400 stack, then restore the saved SP and return. The pinned CCP
launch path pushes address 0000 before jumping to 0100. Under E300 the saved
return word would occupy EAEB–EAEC, above the tools' E400 stacks. Their returns
therefore enter BIOS warm boot, not overwritten CCP code. The inspected adapters
use BDOS through 0005, rather than a fixed resident entry address.

NUC's generated-program provider likewise returns through its caller after
runtime stack restoration. This establishes a plausible provider boundary,
not proof of every generated success, failure or trap path.

New tool releases are consequently a fallback, not an established prerequisite.
Qualification must distinguish the COM load ceiling from runtime stack overlap:
the loader still needs intact CCP code while loading, whereas an admitted
transient may overwrite an explicitly dead region after launch. Tests must
execute unchanged pinned tools through successful and failing exits, inspect
the actual return PC/SP, preserve the launch word and BDOS, and verify CCP
restoration before re-entry. Generic COM compatibility remains unproved.

The next design choice follows upstream tests for open allocations across A/B/A,
explicit FCB drive selection, login/reset vectors and directory state. Prefer a
layout with separately owned component artifacts if the lifetime and execution
proofs support it; do not reserve a now-smaller BDOS tail based on the older
94-byte count.
