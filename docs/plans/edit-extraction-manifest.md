# Edit extraction manifest

Date: 2026-09-05. This manifest fixes the ownership and migration boundary for
Edit before any files leave Debug80. It is not a second source authority and
does not create or publish a repository.

## Destination boundary

Edit is an independently maintained Z80 application. Its first released target
is CP/M, but neither its repository name nor its source layout should make
Triptych or Debug80 its owner. A standalone Edit repository will own the editor
core, its public target contracts, its ATOM build and its portable behavioral
proofs. Triptych and Debug80 will consume a pinned `EDIT.COM` artifact.

The initial target adapter remains deliberately small:

- the CP/M adapter calls the public BDOS entry at `$0005` with documented FCB
  and console conventions;
- the terminal adapter emits and consumes the documented 80×24 ANSI byte
  profile;
- the memory profile places the transient, workspace, text arena and private
  stack for the current CP/M target; and
- the build adapter assembles the complete program with ATOM.

These are target boundaries, not invitations to turn Edit into a host-native
IDE. A later Z80 platform may supply different operating-system, terminal and
memory profiles while retaining the editing core. Rust, WASM, macOS, ESP32 and
Debug80 APIs do not belong in the editor core.

## Current source authority

Until extraction is accepted, authority remains Debug80 at
`jhlagado/debug80`, currently revision
`fa7ad9b2826c8cffded397c830a5ea900d883c1a`. The production source set is:

- `apps/debug80-vscode/roms/cpm22/editor.asm`
- `apps/debug80-vscode/roms/cpm22/editor-memory.asmi`
- `apps/debug80-vscode/roms/cpm22/editor-bdos.asm`
- `apps/debug80-vscode/roms/cpm22/editor-bdos.asmi`
- `apps/debug80-vscode/roms/cpm22/editor-command.asm`
- `apps/debug80-vscode/roms/cpm22/editor-load.asm`
- `apps/debug80-vscode/roms/cpm22/editor-buffer.asm`
- `apps/debug80-vscode/roms/cpm22/editor-navigation.asm`
- `apps/debug80-vscode/roms/cpm22/editor-screen.asm`
- `apps/debug80-vscode/roms/cpm22/editor-save.asm`
- `apps/debug80-vscode/roms/cpm22/editor-search.asm`
- `apps/debug80-vscode/roms/cpm22/editor-replace.asm`
- `apps/debug80-vscode/roms/cpm22/editor-replace.asmi`
- `apps/debug80-vscode/roms/cpm22/editor-main.asm`

The contract and retained evidence are:

- `docs/specifications/cpm22-editor.md`
- `docs/reports/cpm22-editor-proof.md`
- `docs/reports/cpm22-editor-buffer-measurement.md`
- `docs/reports/cpm22-editor-search-measurement.md`
- `docs/reports/cpm22-editor-new-file-measurement.md`
- `docs/reports/cpm22-editor-replace-measurement.md`

The implementation history begins with the contract and candidate study at
`bb47a295`, the first bundled editor at `1e87bdee`, and the retained
search/new-file/replacement sequence ending at `dddcbd68`. Later commits
`6b681502` and `b4bb2ac4` changed the proof and measurement paths to use ATOM
artifacts. That history must be preserved or explicitly referenced by the
extraction; copying only today's files would lose material design evidence.

The retained production artifact is 3,003 bytes with SHA-256
`bbe4ac2b6236d178089fcd01822d0d7fa3c6159f0d2da3655eba1212dda5aa02` as
recorded in the contract. Extraction must reproduce that exact artifact before
an intentional source or interface change is accepted.

## Portable proof boundary

The principal executable proof is `scripts/cpm22/prove-editor.mjs`. Its tests
cover command parsing, load and text validation, buffer edits, navigation,
screen cells and attributes, search, replacement, new-file behavior, the
multi-phase save transaction, failure recovery, stack balance and memory
canaries. Those behaviors belong with Edit.

The four candidate-study families and their measurement drivers also belong
with Edit because they explain the retained design rather than a Debug80
integration:

- `scripts/cpm22/editor-buffer-candidates/` and
  `scripts/cpm22/measure-editor-buffers.mjs`;
- `scripts/cpm22/editor-search-candidates/` and
  `scripts/cpm22/measure-editor-search.mjs`;
- `scripts/cpm22/editor-new-file-candidates/` and
  `scripts/cpm22/measure-editor-new-file.mjs`; and
- `scripts/cpm22/editor-replace-candidates/` and
  `scripts/cpm22/measure-editor-replace.mjs`.

`scripts/cpm22/editor-candidate-assembly.mjs` becomes an Edit-local ATOM
adapter. Candidate results remain historical evidence; they need not run in
every release gate after their retained figures and source inputs are fixed.

The current proof uses the standalone Debug80 Runtime for Z80 execution, CP/M
filesystem access and ANSI terminal modeling. Those are development adapters,
not production dependencies. The extracted suite may initially depend on a
released Runtime package, but it must not import a Debug80 checkout. A second
headless runner using Triptych's Rust core should later replay the same public
transcripts, proving that the test contract is not coupled to one emulator.

## ATOM-only migration

The current proof takes its emitted bytes and debug map from ATOM, but it still
runs an AZM strict sidecar and compares the result. Candidate assembly follows
the same pattern. That comparison is an already-completed migration oracle; it
must not become part of the standalone Edit build or release gate.

Before extraction is qualified:

1. pin a released ATOM revision through an ordinary package dependency;
2. assemble the production and candidate sources through ATOM's public API;
3. derive symbols and extent measurements from the ATOM debug map;
4. express register, clobber and stack expectations as executable tests or
   documented callable-interface contracts rather than AZM directives; and
5. run the entire Edit gate with AZM unavailable and reject any new AZM import.

The `.routine`, `.include`, `.org`, `.equ`, `.db` and `.end` source forms may
remain only where ATOM accepts them directly. AZM is historical provenance,
not an assembler choice for new Edit work.

## Consumer-owned integration

The standalone Edit repository proves the application through its public CP/M
interfaces. Consumers retain only their own integration evidence:

- Triptych installs the pinned artifact in its versioned distribution, boots
  it through the Triptych CCP/BDOS/BIOS stack, checks ANSI rendering and proves
  an edit/save/reload session on native and WASM hosts.
- Debug80 installs the same artifact and keeps Extension Host, terminal-panel
  and debugger integration tests. It no longer owns or rebuilds editor source.
- Another Z80 platform supplies its own adapter or consumes the CP/M artifact;
  it does not depend on Triptych or Debug80.

The component lock selects the immutable Edit source revision, ATOM toolchain,
build recipe, expected length, SHA-256, licence and installed filename. The
output artifact manifest records the actual `EDIT.COM` bytes placed on a disk.
Cargo and npm may run host-side build tools, but neither is the ownership
mechanism for the guest application.

## Migration gates

1. Select the repository name, public remote and licence, then create one empty
   destination with ATOM-only guidance.
2. Import the source, contract, reports, candidate studies and relevant history
   once. Do not leave two writable authorities.
3. Replace the AZM sidecar with ATOM-native assembly and interface tests. Prove
   the existing 3,003-byte artifact exactly before changing behavior.
4. Remove Debug80-relative paths from the proof harness. Run it from a clean
   checkout using released ATOM and Runtime dependencies.
5. Add a small target-profile boundary for CP/M BDOS, ANSI geometry and memory
   placement without rewriting the retained editor core.
6. Publish an immutable source revision and artifact manifest. Pin it in
   Triptych and rebuild a fresh distribution disk.
7. Prove the full edit/save/search/replace workflow through Triptych native and
   WASM hosts, including browser persistence and a reload of the saved file.
8. Migrate Debug80 to the same release, then remove its production editor
   sources and source-build commands while retaining consumer integration
   tests.

Extraction is complete only when Edit builds and proves itself outside
Debug80, both consumers use the same immutable artifact, and a clean Triptych
checkout can compose that artifact without a Debug80 checkout. Until then,
Debug80 remains the sole source authority and Triptych's bundled `EDIT.COM` is
only a staged integration artifact.
