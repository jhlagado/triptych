# Atom BDOS replacement baseline

Status: host artifact measured; replacement not yet implemented

Date: 2026-09-02

## Result

Milestone 0 of the
[Atom BDOS roadmap](../plans/atom-bdos-roadmap.md) freezes the existing system
as a compatibility oracle without adopting its implementation. The
machine-readable fixture is
`test/bdos/fixtures/reference-system.json`, checked by
`tools/check-bdos-baseline.mjs` on every `npm run check`.

## Measured artifact

The measurements below were made from the repository artifact at Triptych
revision `f3f50e5aff92be7436e23892376ca433175b5d30`.

| Artifact                   | Disk offset | Load range     |   Bytes | SHA-256                                                            |
| -------------------------- | ----------: | -------------- | ------: | ------------------------------------------------------------------ |
| Complete disk              |           — | —              | 256,256 | `7d2898386a77ff3c1e84b0141dad251a19be795befadb7dd8a9ba5965ba4654f` |
| CCP                        |     `$0000` | `$E400..$EBFF` |   2,048 | `67fda0f138c3654a2fb15ae49acb2e663c848774779fa9822eda0f6d3a9b8da3` |
| BDOS oracle                |     `$0800` | `$EC00..$F9FF` |   3,584 | `258fe1b659a979fa9adab000fd2ee27b165349179f6b5f5b8b5266ea3385ac22` |
| Embedded transitional BIOS |     `$1600` | `$FA00..$FDFF` |   1,024 | `3b575ee7990ee5865c6ddbf26b1b2c75a8fac81c47ddc285d18d488f83cd5b9d` |
| Fresh Triptych BIOS        |     runtime | `$FA00..$FDFF` |   1,024 | `8bb107b756a4794e0f9f7856f42bd236f2d9c8b9380a515eb2dc12a9b55f3414` |

The checker also proves that `$EC06` contains an absolute jump whose target is
inside the BDOS slot, that the three resident ranges are contiguous, and that
both the embedded and freshly assembled Triptych BIOS images have all 17
absolute-jump vector entries. The two BIOS binaries are intentionally not
equal: every host replaces the transitional disk's embedded BIOS with a fresh
assembly of `roms/cpu/bios.asm` before execution.

The complete-disk digest differs from the originally imported
`51b61f8c8d26a252890b08e78627ba82e1bd92b2dc4a640fd6b64201aa5cb6be`
artifact only because Triptych normalized the text records for `INPUT.ASM`,
`HELLO.ASM`, and `LARGE.ASM` from Unix LF to CP/M CRLF. The system track and
the CCP, BDOS, and BIOS component hashes above are unchanged.

These hashes identify the oracle. A new BDOS is expected to have different
bytes and internal addresses.

## Evidence boundary

The system-call and BIOS contracts come from the public interface documented
in Chapters 5 and 6 of the Digital Research CP/M Operating System Manual. The
transitional BDOS is used only to run black-box cases where application
compatibility requires more precision than the manual supplies. New
implementation code will not be translated or copied from legacy source.

The current disk's grant, components, and origin are recorded in
`third_party/cpm22/PROVENANCE.md` and `third_party/cpm22/LICENSE.txt`.

## Measurement scope

This report records files and host-side assembly only. It contains no ESP32-S3
hardware measurement and makes no claim about SD timing, serial reliability,
power, pacing, or sustained physical operation.

## Direct-harness status

Milestone 1 uses `test/support/bdos-direct-call.ts`. It loads only the frozen
BDOS slot, invokes the public `$EC06` path from a small transient, and replaces
the BIOS with its public 17-entry interface. The harness records registers at
every BIOS entry, applies fixture-defined return values, checks caller-stack
restoration, and rejects writes outside the resident BDOS region, declared
outputs, BIOS workspace, and the caller's two-byte return slot.

Evidence-tagged fixtures now execute every function from 0 through 40, plus an
out-of-range function. Console cases include warm boot, direct and buffered
input, output status polling, tab expansion, control-S pause/resume, control-P
printer echo, backspace editing, I/O byte state, strings, and peripheral I/O.
A semantic BIOS disk double publishes a documented DPH/DPB and models
selection, positioning, sector translation, DMA, 128-byte reads, and writes.
Stateful fixtures prove disk/user/vector state, file open and read, directory
search, create/write/close, attributes, rename, delete, random access, file
size, random-record conversion, and zero-filled extension. Adversarial cases
add wildcard searches across users, the record-127 extent boundary, absent
drive selection, full directory and allocation maps, read-only file and disk
rejection, and injected BIOS read/write failures. Failure cases check the exact
diagnostic bytes, console acknowledgement, page-zero warm-boot transfer, and
absence of rejected disk mutations. They compare public BIOS call traces, FCB
and DMA results, allocation bits, exact directory and data records, and
disk-write counts. The 27 direct fixtures and 14 stateful fixtures are data
under `test/bdos/fixtures/`, not facts extracted from legacy source symbols.
All pass against the hashed oracle.

The failure probes exposed a test-harness defect before replacement work
started: a fatal BDOS error jumps through the public warm-boot vector at
`$0000`. The harness now installs that vector explicitly and requires the
resulting BIOS transfer. Previously, zero-filled page-zero memory could execute
as NOPs and disguise this path as an ordinary return.

The existing WASM proof now reads
`test/bdos/scenarios/ccp-file-roundtrip.json` and feeds each fresh-process CCP
session through the reusable headless scenario runner and DOM-free ANSI
terminal model. It checks the raw transcript, every screen and attribute cell,
cursor, active attributes, pending wrap, and bell state. Arbitrary input-byte
arrays cover control and cursor keys. The `edit-ansi-quit` scenario waits for
`EDIT.COM` to finish drawing and proves its reverse-video status line before
injecting Ctrl-Q; this prevents BDOS console polling from consuming the key
early. Compiler scenarios will use the same host-neutral format. Scenarios can
also assert the persisted disk digest.

## Next proof

Implement disk discovery and the read path: functions 13 through 20 and 24
through 32 as their dependencies require. The replacement must consume DPH and
DPB data from the BIOS, then pass direct fixtures for reset, login, DMA,
directory search, open, close, and sequential read before `DIR`, `TYPE`, and
the repository COM programs move from the oracle to the Triptych BDOS.
