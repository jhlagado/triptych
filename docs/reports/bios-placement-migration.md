# BIOS placement migration

2026-09-05. Baseline: Triptych `c0acdec`, with a clean tracked worktree.

The BIOS now lives at `system/cpm/bios.asm`. It remains Triptych-owned Z80
machine-interface code, loaded from disk into RAM at `$FA00..$FDFF`. The
bootstrap ROM remains at `roms/cpu/bootstrap.asm`. CCP and BDOS extraction is
separate work; their repository name and remote remain undecided.

The move updates the native/browser image helper, headless WASM proof,
TypeScript compatibility proof, console-transient test, reference-fixture
description, package file list, and current ownership documentation. Historical
reports retain the paths used at their recorded revisions. The BIOS source has
only a comment change; instructions, data and storage declarations are intact.

## Equivalence

Both locations were assembled with the public ATOM API pinned to
`27b32ad97ee0596d1952617261b644f8ccc389f9`. Before/after image sizes and SHA-256
digests match for all four system components:

| Component | Bytes | SHA-256                                                            |
| --------- | ----: | ------------------------------------------------------------------ |
| Bootstrap |   256 | `54c6bfd356b4b42f8c51f3b85777a9d2be7aa680945335783c4dd7a6dae8921e` |
| CCP       |  2048 | `0e6100dd4c825f626d70262943b8e5698143dca1dd1d045f3825aaa5e79e486d` |
| BDOS      |  3584 | `d20bcd7c04b3600d18bb26764476616152b387d4ef831309606a54017a9fa081` |
| BIOS      |  1024 | `8bb107b756a4794e0f9f7856f42bd236f2d9c8b9380a515eb2dc12a9b55f3414` |

The BIOS base address and complete exported label map also match. There is no
guest-visible behavior, memory-layout or binary-size change.

## Verification

The following passed after the move, with a Node import guard rejecting AZM:

- `npm exec vitest run test/bdos/console-program.test.ts`: cold boot, transient
  output and warm boot back to the prompt.
- `node tools/check-bdos-baseline.mjs`: frozen reference digests and the
  Triptych BIOS's 17 jump-table entries.
- `npm run check`: 152 TypeScript tests, build/type/lint/format checks, fixture
  gates, Rust formatting/clippy/tests and release WASM compilation.
- `npm run proof:cpm-headless`: 29 scenarios and 33 sessions, checking
  transcripts, ANSI state and declared disk results.
- `TRIPTYCH_CPM22_IMAGE=third_party/cpm22/cpm22.img npm run proof:cpm22-native`:
  `SMOKE.COM` writes `RESULT.TXT`; a second macOS host process reads it.

Rust commands used the installed 1.98.0 macOS toolchain and WASM builds used
wasm-bindgen 0.2.127. `npm pack --dry-run --json --ignore-scripts` includes
`system/cpm/bios.asm` and excludes the removed BIOS path.

An initial focused test overlapped the filesystem move and failed on the old
path; the post-move run above passed. The optional `proof:cpm-image-native`
command was also attempted without its required external ATOM inputs and did
not execute its proof. The two-process native proof above is the measured
native result.

The optional TypeScript compatibility proof exposed an existing missing
`@jhlagado/debug80-runtime/platforms/cpm22/filesystem` module. That dependency
repair is separate from this move; its execution is not included among the
passing results above.

These are host-side results. No Linux run, physical ESP32 or mobile-keyboard
measurement, or GitHub Pages publication was performed for this checkpoint.

## Compatibility-proof follow-up

After the placement commit `1fd24ca`, the compatibility proof was repaired
separately. Its missing external filesystem import was replaced with the
existing `tools/lib/cpm22-disk.mjs` helper used by the headless WASM proofs.
The installer takes a named file descriptor; the reader returns physical
record bytes and throws when the requested file is absent. The call sites now
use those interfaces. Exact command transcripts and file-content assertions
are retained.

Before the repair, `tools/prove-cpm22.mjs` failed during module loading with
`ERR_MODULE_NOT_FOUND`. Afterward,
`TRIPTYCH_CPM22_IMAGE=third_party/cpm22/cpm22.img npm run proof:cpm22` passed
with the AZM import guard. The first boot and commands used 112,033 instructions
and 1,256,558 T-states; reboot and readback used 49,814 instructions and 585,595
T-states. These are emulator counts, not measured hardware timing. The proof
uses the historical CCP/BDOS disk fixture and the current Triptych BIOS.

`node tools/check-cpm-headless-scenario.mjs` also passed after the repair,
including the shared disk helper's multi-extent installation, replacement and
readback checks. Debug80 Runtime remains only the development Z80 execution
adapter in this proof; the missing filesystem module is no longer required.
The full `npm run check` passed again after the repair with AZM imports blocked.
