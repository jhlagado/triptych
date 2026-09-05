# Nucleus native ATOM release checkpoint

2026-09-05. Nucleus 0.3.1 is published and selected by this Triptych pin update.
Upstream qualification, the full local Triptych check and headless replay pass.
Triptych publication and verification of the new hosted disk remain pending at
this checkpoint. The existing hosted distribution still contains Nucleus 0.3.0.

## Published compiler and private execution

The compiler at Nucleus source
[`b5276a85fd36600a10dbd65039f0af3afc033f0d`](https://github.com/jhlagado/nucleus/commit/b5276a85fd36600a10dbd65039f0af3afc033f0d)
contains 21,271 unpadded bytes, loaded at `$0100` through exclusive end `$5417`.
Its SHA-256 is
`1c047ac1ed5ff1c4e914321b66476b842a1b28cc0dfef4cfdb86f691ca037334`.
The manifest declares version `0.3.1` and ATOM revision
`802b5c2d320bec777f427755ff2d7338e3b80a05`, matching Triptych's assembler pin.
The upstream [qualification report](https://github.com/jhlagado/nucleus/blob/b5276a85fd36600a10dbd65039f0af3afc033f0d/docs/reports/atom-native-release-qualification.md)
separates the completed source migration from release qualification.

At [upstream CI run 33952873447](https://github.com/jhlagado/nucleus/actions/runs/33952873447),
all 63 source checks, package qualification and the Node 20 consumer job passed.
Linux reproduced the exact compiler bytes. The Node 24 and Node 20 package
checks passed with matching 373-file archives containing 3,874,617 unpacked
bytes; a fresh macOS package also matched the committed tree for all 373
packaged files. All four shards and the aggregate release gate passed:
737 tests across 69 files, with no failures or skips.
The separate [push qualifier](https://github.com/jhlagado/nucleus/actions/runs/33952873304)
also passed the same complete gate at that source revision.

[Nucleus 0.3.1](https://github.com/jhlagado/nucleus/releases/tag/nucleus-v0.3.1)
tags that exact tested source commit. PR #4 merged it into upstream main at
`61e15b01e393ce215052662f99b340bc4aced341`; the merge contains the tested commit
and its complete tree is identical. Downloaded public executable and manifest
assets matched the committed bytes. The raw manifest SHA-256 is
`ea2555944622b59b45bc89c9aec63e0575eb9ae6d4a1e9c9430942d905132388`.

Fresh assembly after source closure reproduced the earlier private repair
candidate byte-for-byte. An independent replay installed those bytes into
private in-memory copies of Triptych's distribution disk. The existing
Rust/WASM CPU and Triptych BIOS executed these cases with Portable CP/M
residents from `579657f9177b31e1fccf0c05f72ba2ee76f3d052`:

- Scalar-parameter and open-array loop-bound programs each printed exactly
  `A`; a local-loop control printed `ABC`.
- The bundled source compiled and printed `OK`.
- An invalid loop bound reported
  `Nucleus error 39 P=01 O=0037 L=0003 C=0011` and preserved every byte of an
  existing 128-byte `OUTPUT.COM` filled with `$A5`.
- In that same machine instance, the next valid compilation replaced the
  output successfully and its execution printed `OK`.

All commands returned to `A>` and subsequent `DIR` commands succeeded. No
compiler temporary or backup files remained. The upstream
[repair report](https://github.com/jhlagado/nucleus/blob/b5276a85fd36600a10dbd65039f0af3afc033f0d/docs/reports/cpm-materialized-name-identity.md)
records the original failure and the earlier real-OS replay. These measurements
cover emulated execution, not ESP32 hardware or a total operating-system stack
bound.

## Triptych baseline preflight

A clean isolated worktree at Triptych
`1c85df7dd2b31f91ea1cf3500c738376cbf02963` passed `npm run check`, including
275 JavaScript tests, eight browser tests, native-terminal checks, native/WASM
parity and Rust checks. The complete headless scenario replay then passed.
A clean release browser build passed exact verification of all 17 assets,
followed by another successful eight-test browser run.

Those checks used the existing Nucleus 0.3.0 pin: 21,281 bytes with SHA-256
`7b3da3c0b595a88b4906537fe0f76c44f7abd412e248d35d927d1aefd8971ef1`.
The disk digest was
`90afb240503a95b14620a9f829c8c9a63a4ba78798e4327bc16313639454a710`.
This establishes a passing baseline for the forthcoming pin change; it does
not qualify a Triptych distribution containing 0.3.1.

## Triptych update and remaining gates

This update imports the released executable and unchanged manifest, binds them
to the published commit through provenance, and advances the Nucleus component
lock. The focused verified-release, distribution-manifest and disk-distribution
suites pass all 62 tests across three files. ATOM, Edit, the portable OS and the
Triptych BIOS are unchanged, as is the frozen historical CP/M fixture.

The full local `npm run check` passed 275 JavaScript tests across 22 files,
eight browser tests, 18 Rust tests, and the native-terminal, native/WASM parity
and CP/M checks. Its rebuilt development disk has SHA-256
`6f03fe40c4d45f8b8f7ff57949261f5ed5d6f687870d1234af208a3393b1df7e`.
The development manifest explicitly records the uncommitted checkout; this
result does not substitute for a clean release build.

The separate `npm run proof:cpm-headless` passed all 34 scenarios and 39
sessions. That suite retains historical fixtures; the new pinned distribution
was exercised by the full check's distribution, browser and parity gates.
Triptych CI must qualify the resulting commit.
Hosted acceptance must compare the downloaded Pages artifact with actual HTTP
and browser responses, extract `NUC.COM` from the hosted disk, and verify its
unpadded bytes against the upstream release. That hosted result belongs in a
separate revision-specific checkpoint.

Fresh distributions receive the pinned compiler. Existing native working
disks and restored browser disks retain their applications and user files;
resident-system refresh does not upgrade their installed `NUC.COM`. The private
replays and baseline checks changed no saved user disk. The
[browser quick start](../browser-quick-start.md) covers backup and restore.

Two subsequent tasks can proceed independently after their prerequisites:

- Update Debug80's two Nucleus consumption paths: the extension's Node package
  dependency and lockfile, and its separately verified CP/M release inputs and
  import checks. Qualify CP/M execution, extension packaging and an installed
  VSIX before advancing any workspace-launcher pin.
- Migrate the Z80 Tool Services native NOBJ proofs from their current AZM
  imports to canonical ATOM source and assembly. Preserve the service ABI and
  execution tests, qualify its standalone package, and only then advance its
  consumers. Updating a Nucleus dependency alone does not migrate those proof
  assemblers.
