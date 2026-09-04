# Component ownership and release assembly

2026-09-05. Ownership decisions are settled as described below. The lockfile
and artifact pipeline are planned work under S2–S4 of the
[software stability roadmap](software-stability-roadmap.md); no new release
manifest or standalone OS repository has been published yet.

## Source ownership

ATOM, Nucleus and Edit are independently maintained development tools. They
may have CP/M builds without being restricted to CP/M. ATOM and Nucleus already
have standalone repositories; Edit extraction remains pending.

The portable CP/M-compatible operating system will have a separate repository
and release lifecycle. CCP and BDOS move together with their interface
contracts, source history and component tests. The OS name and remote are
still undecided. Triptych becomes a consumer and retains machine integration
tests against the pinned OS release.

The Triptych BIOS remains in Triptych. It is Z80 machine-interface code and
belongs with the machine despite the surrounding Rust implementation. The OS
defines the BIOS call contract; it does not own Triptych's implementation.
An OS test BIOS may simulate those calls without importing Triptych hardware
ports. Supporting a second real machine does not require moving Triptych BIOS.

CCP, BDOS and the current BIOS are loaded from disk into RAM. Their existing
`roms/cpu/` placement is transitional and does not describe their execution
storage. During integration migration, the BIOS destination is
`system/cpm/bios.asm`; the actual bootstrap stays under `roms/cpu/`. Update
every builder, fixture and link in the same verified rename. Do not create a
second maintained copy while leaving callers on the old path.

## Two dependency mechanisms

Cargo manages Triptych's Rust packages and their compiled crates. npm manages
JavaScript development tools. Neither package manager defines ownership of the
guest OS or applications.

A component lockfile will select external Z80 sources and artifacts for a
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
binaries or publish the dirty Nucleus reconciliation as a verified release.

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
