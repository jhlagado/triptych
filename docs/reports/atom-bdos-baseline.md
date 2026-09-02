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
| Complete disk              |           — | —              | 256,256 | `51b61f8c8d26a252890b08e78627ba82e1bd92b2dc4a640fd6b64201aa5cb6be` |
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

## Direct-harness seed

Milestone 1 has begun with `test/support/bdos-direct-call.ts`. It loads only the
frozen BDOS slot, invokes the public `$EC06` path from a small transient, and
replaces the BIOS with 17 one-byte return stubs. The harness records registers
at every BIOS entry, applies fixture-defined return values, checks caller-stack
restoration, and rejects writes outside the resident BDOS region and the
caller's two-byte return slot.

The first evidence-tagged fixtures prove function 12 (return version), function
2 (console output with no pending input), and an out-of-range function. They
are data under `test/bdos/fixtures/functions/`, not facts extracted from legacy
source symbols. All three pass against the hashed oracle.

The existing WASM proof now reads
`test/bdos/scenarios/ccp-file-roundtrip.json` and feeds each fresh-process CCP
session into the DOM-free ANSI terminal model. It checks the raw transcript,
visible screen text, cursor, and bell state. Later editor and compiler scenarios
will use the same format and add attribute and disk assertions.

## Next proof

Extend the direct-call matrix through console functions 0 to 12, including
scripted input, tab expansion, control-S pause/resume, control-P printer echo,
line editing, and warm boot. Only then should replacement assembly begin.
