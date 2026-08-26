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

| Path                  | Contents                                                                    |
| --------------------- | --------------------------------------------------------------------------- |
| `src/cpu`             | boot overlay, serial, storage, port routing, and host reference composition |
| `src/video`           | transport-neutral video processor contract and executable model             |
| `src/sound`           | transport-neutral synthesizer, PCM, mixer, and port model                   |
| `roms/cpu`            | Z80 bootstrap and CP/M compatibility BIOS sources                           |
| `firmware/cpu`        | future ESP-IDF CPU-module firmware                                          |
| `firmware/video`      | future ESP-IDF VGA-module firmware                                          |
| `firmware/sound`      | future ESP-IDF I²S sound-module firmware                                    |
| `docs/specifications` | guest-visible CPU, video, and sound contracts                               |
| `docs/reports`        | measured proof reports                                                      |

The TypeScript code is a reference model for interface decisions. It is not the
ESP32 firmware. Debug80 Runtime is a development-only Z80 test harness; neither
the machine contract nor the sound and video models import it.

## Development

Node.js 20 or newer is required.

```sh
npm install
npm run check
```

The optional CP/M compatibility proof requires a CP/M 2.2 disk image supplied
outside the repository:

```sh
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img npm run proof:cpm22
```

The [architecture note](docs/architecture.md) explains the module boundary and
the [specifications](docs/specifications/) contain the experimental register
contracts.
