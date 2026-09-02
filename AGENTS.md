# Coding-agent guidance

## Project identity

This repository is **Triptych**. Do not call it Triptych-80, Tryptic, Debug80
ESP32, or a Debug80 platform. Triptych is a separate modular computer project
with CPU, video, and sound sections.

The repository path is `/Users/johnhardy/projects/triptych`.

## Ownership boundary

Triptych owns:

- the guest-visible Z80 machine profile;
- CPU-module memory, storage, console, boot, and peripheral routing;
- the video-module logical ports, VRAM, palette, rendering, and timing contract;
- the sound-module logical ports, synthesis, PCM, mixing, and timing contract;
- ESP32 firmware, ROMs, hardware notes, and module-transport work;
- tests and proof reports for those contracts.

Do not add Triptych source, exports, ROMs, scripts, specifications, or UI entries
to the Debug80 repository. Debug80 Runtime and AZM may be used as external
development tools. Imports from those packages belong in `test/`, `tools/`, or
an explicitly named adapter; production code under `src/` and firmware under
`firmware/` must not depend on Debug80.

## Directory map

Put work in the section that owns it:

| Material                        | Destination                 |
| ------------------------------- | --------------------------- |
| CPU contracts and host models   | `src/cpu/`                  |
| Portable Rust CPU core          | `crates/triptych-cpu-core/` |
| Native and WASM CPU hosts       | `crates/triptych-host-*/`   |
| CPU ESP-IDF implementation      | `firmware/cpu/`             |
| Z80 bootstrap and BIOS source   | `roms/cpu/`                 |
| Video contracts and host models | `src/video/`                |
| Video ESP-IDF implementation    | `firmware/video/`           |
| Sound contracts and host models | `src/sound/`                |
| Sound ESP-IDF implementation    | `firmware/sound/`           |
| Shared transport-neutral types  | `src/shared/`               |
| Executable proofs               | `test/`                     |
| Optional development tools      | `tools/`                    |
| Normative contracts             | `docs/specifications/`      |
| Staged development plans        | `docs/plans/`               |
| Measurements and proof reports  | `docs/reports/`             |

Keep CPU, video, and sound independently replaceable. Shared code must express
a genuine wire, guest, or host-test boundary rather than hide module coupling.

## Moving work from another repository

If Triptych material already exists in Debug80 or another project:

1. Record the source repository revision, `git status --short`, and the exact
   files and tracked diff lines that belong to Triptych.
2. Preserve unrelated and pre-existing changes. A dirty worktree is not
   permission to move or revert another person's work.
3. Move the Triptych files into the directory map above. Rename repository-local
   paths, package imports, links, and commands at the same time.
4. Remove only the machine-specific integration residue from the source
   repository. Typical residue includes package exports, root scripts, README
   sections, ROM folders, and device-model exports.
5. Confirm that the source repository has returned to its prior state. Report
   any remaining changes instead of deleting them.
6. Replace production imports from the source repository with Triptych-owned
   interfaces. A simulator may remain a development-only dependency.
7. Run Triptych's complete verification and the source repository's relevant
   regression checks.
8. Record provenance for copied third-party source, ROMs, disk images, fonts,
   samples, libraries, or board material before committing them.

Use exact paths for move and cleanup operations. Do not use broad recursive
deletion, unresolved globs, or destructive Git commands.

## Contract discipline

Read all three current specifications before changing a cross-module boundary:

- `docs/specifications/cpu-v0.1.md`
- `docs/specifications/video-v0.1.md`
- `docs/specifications/sound-v0.1.md`

Preserve the difference between settled architecture and experimental
encodings. An executable TypeScript choice proves one candidate; it does not
silently fix an ESP32 model, GPIO assignment, connector, SPI framing, DAC,
audio block size, sprite budget, or interrupt policy.

Logical Z80 ports and registers are the programmer-visible interface. SPI,
UART, ESP-IDF calls, FreeRTOS tasks, and host callbacks remain private
implementation details.

Multi-byte addresses and frequency values require atomic publication. Storage
writes require bounds checks before publication. Reset must reach a documented
silent or bootable state. Every overload, underrun, malformed transfer, and
out-of-range access needs deterministic behaviour and a proof that
distinguishes corruption from rejection.

## Test-harness boundary

`@jhlagado/debug80-runtime` is currently a development-only Z80 test harness.
Use the adapter in `test/support/debug80-runtime.ts` for CPU tests. Do not import
it from `src/`.

The optional CP/M proof also uses `@jhlagado/azm` and Debug80's CP/M filesystem
helpers. It requires an externally supplied image:

```sh
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img npm run proof:cpm22
```

Do not vendor that image without its complete component provenance and licence
set.

## Verification

Before handoff, run:

```sh
npm run check
```

For focused work, run the narrow test first and the complete check afterward.
Report measured host-model results separately from ESP32 hardware measurements.
Do not claim scanout stability, I²S continuity, SPI margin, or physical timing
from TypeScript tests.

Documentation changes must keep local links valid and must state which claims
are measured, proposed, or still open. The final handoff should name the files
changed, the tests run, and any hardware proof that remains.
