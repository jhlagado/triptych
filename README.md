# Triptych

The current WASM development checkout has a persistent disk box and a
hash-pinned published library. The starter setup uses protected system/tools
in A, personal work in B, protected games in C and personal saves in D, with
four configured drives and up to sixteen supported. The
[disk library roadmap](docs/plans/disk-library-and-launch-links.md) tracks the
remaining work; [library releases](docs/disk-library-releases.md) describes
retention and publication. These instructions do not assert hosted deployment
or completion of the full release gate.

The [browser quick start](docs/browser-quick-start.md) covers a complete
ATOM/Edit/NUC session, Caverns and Hyperdrive adventures, browser saving, backup and restore.

Triptych is the working name for a modular 8-bit computer built from three
cooperating ESP32-family modules:

- the **CPU module** runs a Z80-compatible machine, memory, storage, and system
  firmware;
- the **video module** generates VGA and owns video memory, bitmap modes,
  palettes, tiles, and sprites;
- the **sound module** generates stereo oscillator and PCM audio without
  sample-rate service from the guest CPU.

The name is provisional. It describes the three-part architecture without
fixing the eventual product name in source identifiers or electrical designs.

The current design direction is
[two-MiB disks with configurable drive slots](docs/plans/two-mib-configurable-drives.md):
two-KiB allocation blocks, normally two or four configured drives, with sixteen
as the maximum. The
[release qualification record](docs/reports/two-mib-release-qualification.md)
identifies tested revisions and release evidence.
Existing small-disk and [eight-MiB profiles](docs/plans/eight-mib-disks.md)
remain available; no saved disk is converted automatically. The completed
[browser development workspace](docs/plans/browser-development-workspace.md)
provides individual-file transfers, selected tool updates with recovery backups,
and mobile terminal improvements. These plans follow the
[WASM-first software stability roadmap](docs/plans/software-stability-roadmap.md)
and preserve its independent component releases and host boundaries.
ESP32 physical qualification follows separately when hardware is available.

## Repository layout

| Path                          | Contents                                                                    |
| ----------------------------- | --------------------------------------------------------------------------- |
| `crates/triptych-cpm-image`   | portable CP/M working-image library                                         |
| `crates/triptych-cpm-cli`     | native `triptych-cpm` command-line utility                                  |
| `src/cpu`                     | boot overlay, serial, storage, port routing, and host reference composition |
| `src/video`                   | transport-neutral video processor contract and executable model             |
| `src/sound`                   | transport-neutral synthesizer, PCM, mixer, and port model                   |
| `crates/triptych-cpu-core`    | portable allocation-free Rust CPU machine                                   |
| `crates/triptych-host-native` | macOS/Linux terminal and file-backed disk host                              |
| `crates/triptych-host-wasm`   | headless JavaScript/WASM adapter with owned in-memory disks                 |
| `roms/cpu`                    | Z80 bootstrap ROM                                                           |
| `distribution`                | Pinned component inputs and application samples                             |
| `third_party/portable-cpm`    | Released CCP/BDOS and hash-checked upstream source snapshots                |
| `system/cpm`                  | Triptych CP/M BIOS, loaded from disk into RAM                               |
| `firmware/cpu`                | standalone Rust-over-ESP-IDF CPU-module firmware                            |
| `firmware/video`              | future ESP-IDF VGA-module firmware                                          |
| `firmware/sound`              | future ESP-IDF I²S sound-module firmware                                    |
| `docs/specifications`         | guest-visible CPU, video, and sound contracts                               |
| `docs/reports`                | measured proof reports                                                      |
| `third_party/cpm22`           | transitional CP/M 2.2 demonstration disk, grant, and provenance             |

The TypeScript code is a reference model for interface decisions. It is not the
ESP32 firmware. Debug80 Runtime is a development-only Z80 test harness; neither
the machine contract nor the sound and video models import it.

## Development

Node.js 20 or newer, Python 3, the Rust toolchain pinned in `rust-toolchain.toml`, and a
Playwright-managed Chromium browser are required for the complete acceptance
gate.

```sh
npm install
npx playwright install chromium
npm run check
```

On a clean Linux machine, `npx playwright install --with-deps chromium` also
installs Chromium's operating-system libraries. CI uses that form.

Triptych includes a transitional CP/M 2.2 demonstration disk under the Bryan
Sparks distribution grant recorded in `third_party/cpm22/`. The compatibility
proof can use that image directly:

```sh
TRIPTYCH_CPM22_IMAGE=third_party/cpm22/cpm22.img npm run proof:cpm22
```

The same image can exercise the production Rust core and native host across two
fresh processes:

```sh
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img npm run proof:cpm22-native
```

The interactive macOS/Linux launcher starts the same Rust host in the current
terminal:

```sh
npm run run:cpm22-native
```

The default launcher builds a fresh disk from pinned CCP, BDOS, ATOM, NUC and
Edit, Caverns and Hyperdrive inputs plus the local BIOS and bootstrap. It prints the disk digest and
development manifest. Disk writes last for the session and are discarded on
Ctrl-C. Set `TRIPTYCH_CPM22_IMAGE` only to select an explicit disposable source
copy; that source is not modified. The shorter alias starts the same default:

```sh
npm run run:ccp-native
```

The CCP implements all six CP/M 2.2 resident commands and runs the bundled
editor, assembler, and compiler. Its complete acceptance state is tracked by the
[Atom CCP roadmap](docs/plans/atom-ccp-roadmap.md) and
[CCP contract](docs/specifications/ccp-v0.1.md).

For continuing development, create a fresh persistent disk from the pinned
machine distribution, then address its contents by CP/M filename:

```sh
node tools/create-cpm-working-image.mjs /path/to/triptych-working.img
cargo run -p triptych-cpm-cli -- list \
  /path/to/triptych-working.img
cargo run -p triptych-cpm-cli -- import \
  /path/to/triptych-working.img /path/to/hello.asm HELLO.ASM
cargo run -p triptych-cpm-cli -- export --text \
  /path/to/triptych-working.img HELLO.ASM /path/to/exported-hello.asm
```

The creation command publishes a new destination only; an existing file or
symlink is never replaced. It prints the distribution manifest and requires a
clean checkout unless `--allow-dirty` is explicitly selected for development.
The separate `triptych-cpm create` command copies and sector-pads an
existing image; it does not install machine-compatible system records. `import`
validates the complete directory and allocation map before atomically replacing
the image. Binary exports contain complete 128-byte CP/M records; `--text`
removes trailing CP/M `$1A` text EOF bytes. Add `--force` to `export` only when
an existing Mac file should be replaced.

The CLI and native host acquire exclusive locks on their opened files. Close
the native session before listing, importing or exporting its mounted images;
`--force` does not bypass ownership. Other editors must remain offline unless
they use the same locking policy. The
[CLI ownership notes](crates/triptych-cpm-cli/README.md) describe atomic
replacement, alias handling and filesystem limits.

Select the persistent disk when starting the native terminal:

```sh
TRIPTYCH_CPM22_WORK_DISK=/path/to/triptych-working.img \
npm run run:cpm22-native
```

The launcher preserves all saved bytes, including CCP, BDOS and BIOS. Guest
writes that reach the disk controller's flush boundary remain in the named
working image across host processes. Reopening never upgrades system or tool
records. The selected bootstrap must match the saved resident layout; disk
capacity alone cannot establish that compatibility.

An existing large image requires an explicit bootstrap profile:
`TRIPTYCH_CPM_BOOTSTRAP_PROFILE=triptych-cpu-v0.1-8m-a` for the E400 one-drive
layout, or `triptych-cpu-v0.1-8m-ab` for the E300 A/B layout. Set it alongside
`TRIPTYCH_CPM22_WORK_DISK`. This selects the bootstrap only; it does not migrate
the image or replace residents. The default profile remains the small E400
machine. `TRIPTYCH_CPM_CCP` and `TRIPTYCH_CPM22_IMAGE` cannot be combined with a
saved working disk.

For two distinct saved eight MiB images using the A/B resident layout:

```sh
TRIPTYCH_CPM22_WORK_DISK=/path/to/drive-a.img \
TRIPTYCH_CPM22_WORK_DISK_B=/path/to/drive-b.img \
TRIPTYCH_CPM_BOOTSTRAP_PROFILE=triptych-cpu-v0.1-8m-ab \
npm run run:cpm22-native
```

The launcher rejects incorrect capacities and paths that identify the same file,
including hard links and symbolic links. These checks run before launch; the
native host then acquires exclusive locks on the opened image files. Those
locks exclude cooperating owners, including the CLI, but not arbitrary file
editors. Use `B:` at the CP/M prompt to select B, or an explicit filename such
as `TYPE B:README.TXT`.

The development archive launcher opens a browser-exported `.tds` machine in a
new native session, preserving its saved bootstrap, configured slots and media:

```sh
cargo build --locked -p triptych-host-native
node tools/run-saved-machine-native.mjs \
  --archive /path/to/machine.tds \
  --session /path/to/new-session \
  --deployment /path/to/retained/deployment-manifest.json
```

The destination must not already exist. The original archive and all extracted
files remain after exit. Two-MiB archives require matching profile metadata;
historical archives need no `--deployment` argument. This launcher performs no
system upgrade. Session disk files are raw recovery data, not last-flush
checkpoint archives, and are not automatically repacked. The
[native archive plan](docs/plans/native-saved-archives.md) explains that boundary;
the [verification report](docs/reports/native-saved-archive-sessions.md) records
the local macOS test scope. The
[release qualification record](docs/reports/two-mib-release-qualification.md)
tracks integrated qualification.

The Stage 5 WebAssembly proof additionally needs the exactly matching
`wasm-bindgen` 0.2.127 command-line tool:

```sh
cargo install wasm-bindgen-cli --version 0.2.127 --locked
```

```sh
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img \
npm run proof:wasm-host
```

CCP and application sessions can also be replayed without the browser. The
default proof boots the repository's provenance-reviewed disk and runs every
scenario under `test/bdos/scenarios/` and `test/ccp/scenarios/`: built-in and
loader boundaries, CCP file and `DIR`/`TYPE` workflows, a staged `EDIT.COM`
ANSI session, and `ATOM.COM` and `NUC.COM` compilation followed by execution of
their output in a fresh machine. It checks exact serial bytes, complete ANSI
screen state, and declared disk digests:

```sh
npm run proof:cpm-headless
```

Set `TRIPTYCH_CPM_SCENARIO=/path/to/scenario.json` to replay another CCP or
`.COM` scenario. The
[headless scenario contract](docs/specifications/cpm-headless-scenarios-v1.md)
defines readable ASCII and arbitrary byte inputs, terminal snapshots, and
cross-session disk persistence.

The same toolchain builds an interactive browser terminal with the retained
published library. Normal reopening preserves saved personal disk bytes and
the selected configuration. Adapting an external image to the current resident
system is a separate, explicit operation with a recovery backup. Start the
local browser server with:

```sh
npm run run:wasm-browser
```

Open `http://127.0.0.1:8080/`, click the terminal, and type at the `A>` prompt.
In a fresh disk box, A/C are protected. Use Files to import sources and stage
ATOM, NUC and Edit onto writable B, then enter `B:` for development. To play
the published games with private saves, enter `D:` followed by `C:CAVERNS` or
`C:HYPERDRV`. The [quick start](docs/browser-quick-start.md) has the complete
file-transfer, edit and build sequence.

After a successful guest flush, personal disk checkpoints are saved in browser
IndexedDB storage. Published mounts retain metadata references rather than
personal copies of the images. Ejected personal disks remain in the disk box.
Older browser saves require explicit adoption; their system and file bytes are
preserved. The Files image picker remains available for explicit imports; a
different local build input does not replace existing saved media.

Public recipe links reproduce a specified setup using the recipient's own local
writable disks. The **Bookmark on this device only** link selects a saved
configuration in the current browser profile and origin; it does not share
personal data or recreate that configuration elsewhere. Download a `.tds` for
the selected inserted disk arrangement, or complete `.tdbr` recovery data for
the whole disk box, including ejected personal disks and historical records.

The page implements Triptych's bounded 80-by-24 ANSI profile,
including cursor movement, erase, bold, underline, reverse video, scrolling,
and arrow-key input, so full-screen CP/M programs such as `EDIT.COM` work
without displaying raw escape sequences.

The real-browser acceptance suite drives the same public page through Edit,
NUC, persistence, download/reimport, a failed storage transaction, paste and
the narrow keyboard layout:

```sh
npm run test:wasm-browser
```

The ESP32-S3 firmware uses a separate pinned Espressif Xtensa toolchain. Its
[setup and build instructions](firmware/cpu/README.md) produce both an
application image and a merged flash image:

```sh
npm run build:cpu-firmware
```

The [architecture note](docs/architecture.md) explains the module boundary and
the [specifications](docs/specifications/) contain the experimental register
contracts. Current implementation work is limited to the CPU module; the
[CPU development plan](docs/plans/cpu-development.md) records the portable
Rust, native, WebAssembly, ESP32-S3, and breadboard stages and their proof
gates. The [component-lock contract](docs/specifications/component-lock-v1.md)
defines how the release selects independently maintained Z80 software
without treating those projects as Rust crates. The
[Atom BDOS roadmap](docs/plans/atom-bdos-roadmap.md) and
[BDOS contract](docs/specifications/bdos-v0.1.md) define the independent,
interface-driven replacement of the transitional BDOS. The
[Atom CCP roadmap](docs/plans/atom-ccp-roadmap.md) and
[CCP contract](docs/specifications/ccp-v0.1.md) define its independently
implemented resident replacement. The
[CPU conformance contract](docs/specifications/cpu-conformance-v1.md)
and [Stage 1 report](docs/reports/cpu-stage1-conformance.md) retain the first
cross-language fixtures and the Rust Z80-engine decision. The
[CPU Alpha report](docs/reports/cpu-alpha.md) records the exact native, Linux,
WebAssembly, Xtensa, CP/M, and persistence proofs. The
[native working-disk report](docs/reports/cpu-native-working-disk.md) records
the Rust image utility and pinned Atom development workflow. The
[Stage 5 report](docs/reports/cpu-stage5-wasm.md) records the JavaScript-facing
WASM conformance and CP/M results. The
[Stage 6 report](docs/reports/cpu-stage6-espidf-build.md) records the standalone
ESP-IDF builds on macOS and clean Ubuntu, their image sizes, and the remaining
physical-hardware gate.
