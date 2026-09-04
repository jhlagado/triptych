# Triptych ATOM build migration

2026-09-05. Triptych source migration, cold installation, full checks and
headless execution are verified. This is the Triptych portion of S1 in the
[software stability roadmap](../plans/software-stability-roadmap.md), based on
Triptych `7d56d4a` plus the changes described here. Nucleus reconciliation and
Atom's own bootstrap/release migration remain separate unfinished work.

## Assembly boundary

Triptych now pins `atom-z80` to source revision
`27b32ad97ee0596d1952617261b644f8ccc389f9`. The direct AZM dependency is removed.
The public native ATOM API assembles source in `tools/lib/assemble-atom.mjs`.
The BDOS test helper, native disk builder, TypeScript CP/M proof and headless
WASM proof all use that implementation. It returns a flat image at the lowest
source address and an absolute label map. No source translation or fallback
assembler runs during these builds.

The bootstrap and BIOS now use ATOM-sized symbols, bare directives and explicit
zero padding. The bootstrap's forward length expression uses a named equate
resolved by ATOM after both labels are defined. The CCP page-zero probe uses
ATOM string spelling and numeric character-arithmetic operands. CCP and BDOS
assembly source is unchanged. Machine ports, resident slots, entry addresses
and disk layout are unchanged; the BIOS still belongs to Triptych.

Seven new build-boundary tests cover forward patches, absolute labels,
equate exclusion, ORG gaps, trailing storage, a zero-based bootstrap, invalid
symbols, empty output and missing source. The existing BDOS tests retain their
execution, stack, memory, filesystem and failure assertions.

## One-off comparison

Before changing the source, an isolated AZM comparison captured the old emitted
bytes and label addresses. That saved result was compared with ATOM output;
AZM was not used to determine any new address or patch. All six binaries match
byte-for-byte, and all 396 original label addresses match after the explicit
symbol renames. No comparison assembler is retained as a test prerequisite.

| Source          | Base   | Bytes | Labels compared | SHA-256                                                            |
| --------------- | ------ | ----- | --------------- | ------------------------------------------------------------------ |
| Bootstrap       | `0000` | 256   | 8               | `54c6bfd356b4b42f8c51f3b85777a9d2be7aa680945335783c4dd7a6dae8921e` |
| BIOS            | `FA00` | 1,024 | 39              | `8bb107b756a4794e0f9f7856f42bd236f2d9c8b9380a515eb2dc12a9b55f3414` |
| CCP             | `E400` | 2,048 | 96              | `0e6100dd4c825f626d70262943b8e5698143dca1dd1d045f3825aaa5e79e486d` |
| BDOS            | `EC00` | 3,584 | 235             | `d20bcd7c04b3600d18bb26764476616152b387d4ef831309606a54017a9fa081` |
| Console probe   | `0100` | 27    | 2               | `4d1270c845e6726b1781c2833b78eee4f2e3ae669b39d8cfe51de504a117804c` |
| Page-zero probe | `0100` | 230   | 16              | `5b2aa38b306f72bec01e226dba731f010ed0c1ee2c74a1041f922ca29888c561` |

Code, data, workspace, generated-program bytes and guest timing have zero
binary-level change at these comparison boundaries. This is not a host build
speed comparison or a new hardware timing measurement.

## Verification

The final assembly and execution runs followed a fresh-cache npm installation
and used a temporary Node import guard that
rejects the AZM package and resolved AZM module paths before evaluation.

- The focused BDOS group passed all 100 tests.
- The new ATOM helper group passed all seven tests.
- The full TypeScript suite passed all 152 tests in 12 files.
- `npm run check` passed, including Rust formatting, Clippy, 16 Rust tests,
  embedded fixture checks and the WASM release build.
- BDOS baseline validation and the CCP matrix check passed. The matrix still
  reports 17 of 21 features proved; this migration does not complete it.
- `npm run proof:cpm-headless` passed all 29 scenarios and 33 sessions after
  the fresh-cache installation. These include both
  historical OS fixtures and Triptych replacements, ATOM and Nucleus program
  builds/runs, editor open/quit, page-zero checks, file roundtrips, loader
  limits and resident self-assembly. Application binaries still come from the
  existing distribution; this does not qualify the unpublished Nucleus build
  or a standalone Edit release.
- `npm run proof:cpm22-native`, with the reviewed bundled image explicitly
  selected, passed the SMOKE.COM file-write/read check across two native
  processes using Triptych CCP and BDOS.
- `npm run build:wasm-browser` produced the local browser artifact with ATOM
  resident binaries and wasm-bindgen 0.2.127. No Pages publication or physical
  browser-device test was performed.

The first full check stopped because `rustfmt` was absent from the shell PATH.
With the pinned toolchain selected, native Rust tests and checks passed, but
direct invocation of its WASM linker could not locate `libLLVM.dylib`. The
same pinned installation built WASM with its library path supplied; subsequent
builds used the installed rustup proxies and an explicit toolchain directory.
The final full check passed using the rustup proxies on PATH and
`RUSTUP_TOOLCHAIN` set to the installed 1.98.0 toolchain directory. No global
shell configuration or toolchain installation was changed.

## Cold-install investigation and resolution

`npm ci --cache /tmp/triptych-atom-migration.tosxnh/npm-cache` completed with
the AZM import guard active, but a subsequent full check failed at module
loading: the installed ATOM package had no `@jhlagado/z80-tool-services`.
Thus npm's successful exit did not establish a usable installation.

A fresh `npm pack` of the pinned Git revision reproduced the packaging
symptom: 98 entries, 969,167 unpacked bytes and an empty `bundled` list, despite
the package declaring its runtime and tool services as bundled dependencies.
The existing packed-package test exercises a populated source checkout and
does not establish this Git-consumer path.

The failure was traced to npm 11.16.0's dependency-tree loading with a
symlinked cache path on this macOS host. `/tmp` resolves to `/private/tmp`.
Loading the same prepared package through the symlink produced a link node
with zero dependency entries and zero children; its target had three of each.
Loading it through the canonical path produced an ordinary root node with
all three entries and children. npm's pack walker enumerated the empty link
node, omitting the bundles. This corrects the initial attribution to ATOM.

A new empty cache under
`/private/tmp/triptych-atom-migration.tosxnh/real-cache` allowed the unchanged
ATOM revision to install, assemble and pass the complete Triptych checks.
No ATOM source fix or dependency-pin change was needed. The isolated
manifest-alias experiment `63e3de6` did not solve the problem and was reverted
by `20aafa9`; its worktree has no source difference from Atom main.

`npm run check:atom-install` now provides a repeatable consumer check. It
canonicalises its temporary directory with `realpath`, installs the pinned
Git revision with a fresh cache, assembles an exact four-byte program and
checks the exported CP/M image against its census. It then repacks the
installed package, checks both bundled dependency names, installs that
archive offline with another empty cache and repeats the same proof. Both
consumers passed with AZM absent from their module-resolution paths. Their
CP/M image was 15,029 bytes with SHA-256
`cdd5d05e3131b23288914b354929cfb5c2e1639d71c35f337e8fcec8c2bdfcbb`.
The offline step tests the Git-produced package; it does not execute or
qualify Atom's unfinished source-release scripts.

The new assembly helper was reviewed against image-base selection, gap and
reserve handling, forward patches, label extraction and failure publication.
The exact-output comparison and focused tests cover those paths. The two
historical conformance-program source listings remain outside this build
path; their checked JSON byte fixtures were not regenerated or requalified as
ATOM source in this migration.

## Remaining work

Finish Nucleus's remaining source-assembly proofs and replace Atom's own AZM
bootstrap/release scripts. Then qualify clean component publication and advance
consumer pins. OS extraction, standalone Edit, a source-pinned distribution,
durable browser storage and final CI/Pages verification remain open. No ESP32
physical measurement is part of this checkpoint.
