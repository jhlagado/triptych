# Portable operating-system extraction manifest

Date: 2026-09-05. This manifest fixes the ownership and migration boundary
before an operating-system repository is named or created. It is not a release
manifest and does not authorize a source copy to become a second authority.

## Destination boundary

The portable operating-system repository owns CCP, BDOS and the contracts they
implement. It must build and test without Triptych, Debug80 or a physical
board. ATOM is its assembler. A small test BIOS provides the documented CP/M
entry points without adopting Triptych ports, disk transport or boot behavior.

Triptych continues to own `system/cpm/bios.asm` and
`roms/cpu/bootstrap.asm`. It composes the operating-system release with those
machine components and proves the resulting disk on its Rust hosts. BIOS is a
dependency direction at the interface: BDOS calls a specified BIOS API, while
each machine owns its implementation.

The local `/Users/johnhardy/projects/cpm22` directory is an unversioned old
Debug80 starter containing a 35-byte demonstration program. It is neither a
source authority nor a suitable extraction destination.

## Files that become operating-system authority

The first extraction carries these implementations and specifications with
their relevant Git history:

- `roms/cpu/ccp/ccp.asm`
- `roms/cpu/bdos/bdos.asm`
- `docs/specifications/ccp-v0.1.md`
- `docs/specifications/bdos-v0.1.md`

The destination should use neutral paths such as `src/ccp.asm` and
`src/bdos.asm`. Load addresses and slot capacities belong in a named target
profile, not in the repository name or a `roms` directory. The initial profile
retains CCP at `$E400` with 2,048 bytes and BDOS at `$EC00` with 3,584 bytes so
Triptych can compare the extracted output exactly.

The OS repository must also publish a narrow BIOS-call contract derived from
the existing specifications and public CP/M interface. That contract defines
entry numbers, registers, return values and observable disk/console effects. It
must not mention Triptych GPIO, Rust types or host storage.

## Component proofs to extract

The BDOS component suite is already the strongest portable seam. These files
move with adaptation of repository-relative imports only:

- `test/bdos/direct-call.test.ts`
- `test/bdos/randomized-filesystem.test.ts`
- `test/bdos/directory-write-failure.test.ts`
- `test/bdos/bios-double.test.ts`
- `test/bdos/fixtures/functions/`
- `test/bdos/fixtures/sequences/`
- `test/support/bdos-bios-double.ts`
- `test/support/bdos-direct-call.ts`

The assembler helper becomes an OS-local ATOM adapter. It must use ATOM's
public API and must fail if AZM is imported. The TypeScript Z80 runtime may be a
development dependency through its standalone package; it cannot point back
into Debug80.

The CCP component suite needs a neutral machine runner before it moves. The
portable portion covers command parsing, page-zero publication, transient
loading, built-ins, failure recovery and resident memory bounds. The
Triptych-specific scenarios remain in Triptych until an equivalent OS-local
runner exercises the same transcripts through the test BIOS.

## Evidence retained by Triptych

Triptych keeps the following classes of proof after extraction:

- real `system/cpm/bios.asm` assembly and BIOS placement checks;
- bootstrap, disk layout and system-record installation;
- native Rust, WASM and browser boot scenarios;
- application scenarios for ATOM, NUC and Edit on the composed disk;
- working-disk persistence and release-image digests;
- ESP32 integration and measurements when hardware is available.

During migration, Triptych may temporarily retain mirrored CCP/BDOS sources so
old and extracted builds can be compared. They must be marked transitional and
removed in the same change that advances Triptych to an immutable OS revision.
The release component lock, rather than Cargo or npm, records that revision,
build recipe, ATOM toolchain and resident placement.

## Historical compatibility material

The frozen CP/M 2.2 disk and its grant remain black-box test inputs. Tests may
compare public calls, transcripts and disk effects against those bytes. The
portable implementations must not be copied, translated or mechanically
derived from an original CCP or BDOS binary or source listing. Provenance and
digest records travel with any compatibility fixture that the OS repository
retains.

## Migration gates

1. Choose the OS name and create one empty repository with its licence and
   ATOM-only guidance.
2. Import the implementation and contract histories once, then make that
   repository the only source authority.
3. Establish the test BIOS and move the BDOS direct-call suite. Require the
   existing deterministic and randomized cases to pass unchanged.
4. Add an OS-local CCP runner and port parser, built-in, loader, recovery and
   memory-bound proofs.
5. Build both resident binaries from a clean checkout and emit sizes, entry
   points and SHA-256 values in an artifact manifest.
6. Pin that immutable revision in Triptych's component lock. Rebuild a fresh
   disk with the Triptych BIOS and run the headless, native and browser suites.
7. Remove the transitional Triptych source copies and paths only after the
   consumer proof passes. Debug80 may then consume the same release as a
   development integration, never as an authority.

Extraction is complete when the OS repository passes independently and a
clean Triptych checkout builds the same qualified system from its pinned
release. A local linked checkout is useful for development but is not release
evidence.
