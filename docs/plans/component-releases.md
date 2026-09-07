# Component ownership and release assembly

2026-09-05. Ownership decisions are settled as described below. The
[component-lock v1 contract](../specifications/component-lock-v1.md) and its
validator define the input boundary. The populated lock and private fresh-disk
builder now pass a headless workflow; final consumer qualification and publication
remain work under S2–S4 of the
[software stability roadmap](software-stability-roadmap.md). Portable CP/M
`v0.1.0` is published and selected by the distribution lock; the browser/native
defaults now use that distribution. Clean-release and hosted acceptance remain open.

## Source ownership

ATOM, Nucleus and Edit are independently maintained development tools. They
may have CP/M builds without being restricted to CP/M. All three now have
standalone repositories. The
[Edit extraction manifest](edit-extraction-manifest.md) records the exact
source, proof and adapter boundary. Edit `v0.1.1` is published at immutable
revision `2427501773e8d158d556631b8a4ba1cb972fcb4a`. Triptych vendors and
verifies that release artifact in the S4 distribution builder.

The portable CP/M-compatible operating system has a separate repository,
[`jhlagado/portable-cpm`](https://github.com/jhlagado/portable-cpm), and release
lifecycle. CCP and BDOS were extracted together with interface contracts,
source history and component tests. Release `v0.1.0` pins commit
`579657f9177b31e1fccf0c05f72ba2ee76f3d052`. Triptych becomes a consumer and retains machine integration
tests against the pinned OS release. The
[extraction manifest](os-extraction-manifest.md) lists the exact first source,
contract and proof boundaries.

The Triptych BIOS remains in Triptych. It is Z80 machine-interface code and
belongs with the machine despite the surrounding Rust implementation. The OS
defines the BIOS call contract; it does not own Triptych's implementation.
An OS test BIOS may simulate those calls without importing Triptych hardware
ports. Supporting a second real machine does not require moving Triptych BIOS.

CCP, BDOS and the BIOS are loaded from disk into RAM. The Triptych BIOS is at
`system/cpm/bios.asm`; the actual bootstrap stays under `roms/cpu/`. The CCP and
BDOS now come from the pinned Portable CP/M release. Hash-checked upstream sources
under `third_party/portable-cpm/src/` support integration proofs, not independent
development. The transitional `roms/cpu/ccp/` and `roms/cpu/bdos/` copies are removed. There is
one maintained BIOS source, shared by the image builders and machine proofs.

## Two dependency mechanisms

Cargo manages Triptych's Rust packages and their compiled crates. npm manages
JavaScript development tools. Neither package manager defines ownership of the
guest OS or applications.

A component lockfile selects external Z80 sources and artifacts for a
Triptych release. Triptych's own BIOS and bootstrap are selected by the
Triptych source revision being built. They need no external package or
self-referential revision entry in that lockfile.

Wrapping every assembly project as a Rust package would tie its distribution
to Cargo without changing how ATOM builds it. A separate lockfile keeps
component releases usable from Node, Rust, shell tools or another machine's
build system. It supplements Cargo.lock and package-lock.json rather than
replacing their language-specific dependency information.

## Input lockfile

The initial lockfile needs these records:

| Record                    | Required information                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------- |
| Format                    | Explicit schema version and target-profile identifier                                           |
| External source           | Component ID, repository URL and complete immutable commit ID                                   |
| Build recipe              | A named recipe implemented by trusted local tooling, plus declared target options               |
| Toolchain                 | Exact ATOM input revision/seed identity and references to the Rust/Node toolchain locks         |
| Prebuilt input, when used | Artifact identity, exact byte length and expected SHA-256, linked to its source revision        |
| Placement profile         | Resident entry/slot addresses, disk geometry, reserved system records and application filenames |
| Provenance                | Component licence and origin records                                                            |

A branch or tag can be a human-readable label but cannot substitute for the
immutable revision. Source overrides are development-only and must mark the
result non-release. Release builds reject missing pins, dirty component
sources, hash mismatches and required components whose source cannot be
identified. A remote manifest cannot supply arbitrary shell commands to run.

Current historical disk fixtures remain separately identified until their
replacement artifacts reproduce. Do not invent source pins for inherited
binaries. Nucleus's reconciled `nucleus-v0.3.0` release is published at
`52cca195d1b557ebfbbc3a6d924ca3d6ea657829`; consuming it remains an explicit
pin-and-digest update, not permission to use an arbitrary local worktree.

## Build sequence and output manifest

1. Validate the input lockfile and obtain inputs in managed directories. Do
   not reset, clean or update the user's working repositories.
2. Build the selected ATOM toolchain, then the OS and application artifacts.
   Assemble the Triptych BIOS and bootstrap with the same pinned ATOM API.
   Each component's own tests run in its owning repository.
3. Build the selected Rust host with Cargo's locked dependencies. WASM output
   uses the pinned matching wasm-bindgen tooling.
4. Validate resident sizes and entry points, then create a fresh release disk
   containing CCP, BDOS, BIOS and the selected applications/sample files.
   Image construction must not mutate a user's working disk.
5. Emit an artifact manifest containing the Triptych revision, input-lockfile
   hash, resolved toolchain identities and each output's path, size and
   SHA-256. Record resident placement and the final disk digest. Keep volatile
   timing/log data outside the deterministic artifact identity.
6. Run headless, native and browser acceptance against those outputs. Publish
   that same artifact set, then verify the downloaded Pages bytes and boot.

The artifact manifest describes a completed build; it is not permission to
accept unverified input. A single release command will coordinate these steps,
with separate commands available for component development and diagnosis.
No such new all-in-one command is claimed by this plan yet.

## Update and extraction gates

An OS update changes a pin and produces a new tested disk. Installing that
release is separate from upgrading or replacing a writable user disk. Backup,
restore and explicit selection must precede changes to saved work.

Before OS extraction, inventory exact owned files and tracked diffs, preserve
history, isolate target placement from portable behavior and prove an alternate
headless target configuration. Move component proofs with their source and
retain Triptych-specific boot/disk/console scenarios locally. The BIOS remains
the machine adapter throughout. Extraction is complete only after both sides
build independently and the consumer uses an immutable dependency.

## ATOM and Nucleus consumer updates

Added 2026-09-07. The dated release identities above record the extraction
milestones; the checked-in component and package locks select build inputs.
Every ATOM or Nucleus release requires an explicit Triptych consumer review,
even when the decision is to retain the currently qualified version.

1. Qualify the component in its authoritative repository. Record the committed
   and pushed revision, release assets and digests, interface changes and
   passing upstream checks. An active worktree or a passing subset of tests is
   not a release input.
2. Inspect Triptych's assembly API, component locks, retained artifacts,
   browser tool catalog, source loader and diagnostic mapping for affected
   boundaries. An ATOM update also requires checking the assembler identity
   recorded for retained OS releases; changing only package.json is insufficient.
3. Update compatible pins and verified artifacts together. Record a deliberate
   deferral when the component remains under qualification or requires an
   unresolved interface change. Never substitute a sibling worktree's build
   or an unpinned download for the selected release.
4. Exercise the tools in each supported resident memory layout: load, compile,
   execute, edit, save and return to the CCP, including memory-boundary and
   failure cases. Artifact size alone does not prove buffer and stack safety.
5. Run the complete Triptych checks and Linux CI, construct the release, then
   verify the published asset bytes and hosted browser workflow. Record the
   exact upstream and consumer revisions in a human-facing release report.
6. Keep fresh installation separate from saved disks. Reopening existing media
   preserves their tool and system bytes. A user-requested tool update requires
   the existing backup and recovery flow before publishing replacements.

The pending Nucleus single-stream integration has an ordered 1–255-source-file
loader contract and a 65,535-byte logical stream limit. That byte count includes
one inserted LF after every source that lacks a final LF. Qualification must
cover acceptance of 255 files, rejection of 256 before compilation, byte-limit
boundaries, invalid or duplicate source identities, invalid bank placements,
and global-to-file-local diagnostic and debug mapping. Triptych's current
16-file browser limit remains until the compatible Nucleus release and consumer
tests are qualified together. Project export/import follows that integration;
it must preserve maintained source order and source-map semantics.
