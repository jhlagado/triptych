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
| `roms/cpu`                    | Z80 bootstrap and CP/M compatibility BIOS sources                           |
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
boot ROM and BIOS, and installs them in a temporary copy of the disk. CP/M disk
writes last for the session and are discarded when the launcher exits with
Ctrl-C; the supplied image is never modified.

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

The launcher installs the current Triptych BIOS atomically before boot. Guest
writes that reach the disk controller's flush boundary remain in the named
working image across host processes.

The Stage 5 WebAssembly proof additionally needs the exactly matching
`wasm-bindgen` 0.2.127 command-line tool:

```sh
cargo install wasm-bindgen-cli --version 0.2.127 --locked
```

```sh
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img \
npm run proof:wasm-host
```

The same toolchain builds an interactive browser terminal. The bundled disk
starts CP/M automatically:

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
gates. The [CPU conformance contract](docs/specifications/cpu-conformance-v1.md)
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
