# Triptych

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

The current cross-project goal is the
[WASM-first software stability roadmap](docs/plans/software-stability-roadmap.md):
independent ATOM, Nucleus and Edit releases, qualified CP/M components, and a
reproducible browser edit/build/run workflow with recoverable working disks.
ESP32 physical qualification follows separately when hardware is available.

## Repository layout

| Path                          | Contents                                                                    |
| ----------------------------- | --------------------------------------------------------------------------- |
| `crates/triptych-cpm-image`   | native CP/M working-image library and command-line utility                  |
| `src/cpu`                     | boot overlay, serial, storage, port routing, and host reference composition |
| `src/video`                   | transport-neutral video processor contract and executable model             |
| `src/sound`                   | transport-neutral synthesizer, PCM, mixer, and port model                   |
| `crates/triptych-cpu-core`    | portable allocation-free Rust CPU machine                                   |
| `crates/triptych-host-native` | macOS/Linux terminal and file-backed disk host                              |
| `crates/triptych-host-wasm`   | headless JavaScript/WASM adapter with owned in-memory disks                 |
| `roms/cpu`                    | Z80 bootstrap ROM; transitional CCP/BDOS sources pending OS extraction      |
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

Node.js 20 or newer and the Rust toolchain pinned in `rust-toolchain.toml` are
required.

```sh
npm install
npm run check
```

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
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img npm run run:cpm22-native
```

The launcher prints the source image's SHA-256 digest, assembles Triptych's
boot ROM, CCP, BDOS, and BIOS, and installs the resident components in a
temporary copy of the disk. CP/M disk writes last for the session and are
discarded when the launcher exits with Ctrl-C; the supplied image is never
modified. The shorter CCP-specific command starts the same configuration:

```sh
npm run run:ccp-native
```

The CCP implements all six CP/M 2.2 resident commands and runs the bundled
editor, assembler, and compiler. Its complete acceptance state is tracked by the
[Atom CCP roadmap](docs/plans/atom-ccp-roadmap.md) and
[CCP contract](docs/specifications/ccp-v0.1.md).

For continuing development, create a persistent native-host working disk and
address its contents by CP/M filename:

```sh
cargo run -p triptych-cpm-image -- create \
  /path/to/cpm22.img /path/to/triptych-working.img
cargo run -p triptych-cpm-image -- list \
  /path/to/triptych-working.img
cargo run -p triptych-cpm-image -- import \
  /path/to/triptych-working.img /path/to/hello.asm HELLO.ASM
cargo run -p triptych-cpm-image -- export --text \
  /path/to/triptych-working.img HELLO.ASM /path/to/exported-hello.asm
```

`create` refuses to overwrite an existing destination and pads the established
256,256-byte CP/M image to the native host's 512-byte sector boundary. `import`
validates the complete directory and allocation map before atomically replacing
the image. Binary exports contain complete 128-byte CP/M records; `--text`
removes trailing CP/M `$1A` text EOF bytes. Add `--force` to `export` only when
an existing Mac file should be replaced.

Select the persistent disk when starting the native terminal:

```sh
TRIPTYCH_CPM22_WORK_DISK=/path/to/triptych-working.img \
npm run run:cpm22-native
```

The launcher installs the current Triptych CCP, BDOS, and BIOS atomically
before boot. Guest writes that reach the disk controller's flush boundary
remain in the named working image across host processes.

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

The same toolchain builds an interactive browser terminal. It installs the
current Triptych CCP, BDOS, and BIOS into the bundled or user-selected disk
before starting CP/M automatically:

```sh
npm run run:wasm-browser
```

Open `http://127.0.0.1:8080/`, click the terminal, and type at the `A>` prompt.
Set `TRIPTYCH_CPM22_IMAGE` to override the bundled disk; the page also retains
its file picker. The browser modifies only its in-memory disk. The download
control exports a new image containing guest writes that CP/M has flushed. The
page implements Triptych's bounded 80-by-24 ANSI profile, including cursor
movement, erase, bold, underline, reverse video, scrolling, and arrow-key
input, so full-screen CP/M programs such as `EDIT.COM` work without displaying
raw escape sequences.

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
defines how a future release selects independently maintained Z80 software
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
