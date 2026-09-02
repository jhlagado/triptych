# CPU firmware

This directory contains the ESP32-S3 host for the portable Triptych CPU core.
The Stage 6 image is a serial-only conformance self-test; SD and the complete
machine host follow after physical bring-up. The guest-visible contract is the
[CPU v0.1 specification](../../docs/specifications/cpu-v0.1.md); the staged
implementation and proof gates are in the
[CPU development plan](../../docs/plans/cpu-development.md).

## First hardware target

The first CPU prototype targets the
**Waveshare ESP32-S3-DEV-KIT-N16R8-M**, SKU **28836**:

- ESP32-S3-WROOM-1-N16R8;
- 16 MiB quad-SPI flash;
- 8 MiB octal PSRAM;
- onboard PCB antenna;
- pre-soldered 2.54 mm headers;
- one USB-C connection exposing native USB and USB-to-UART through the board's
  hub.

Two Waveshare boards have been ordered and are awaiting delivery. Record the
module markings and contents of the order before treating either unit as a
qualified target. The firmware configuration must verify rather than assume
the detected flash and PSRAM sizes.

The CPU prototype uses a separate microSD breakout over 3.3 V SPI. If the
ordered hardware does not include that breakout, it remains required before
the storage stage. The CPU unit does not require an Adafruit Metro, Arduino
framework, surface-mount work, or custom PCB.

## Breadboard arrangement

Use two full-size solderless breadboards so the wide development board can sit
across their join without hiding every adjacent connection hole. The microSD
breakout can occupy the second board or another free area.

During initial bring-up:

- power the ESP32 from a known-good USB-C data cable;
- power the microSD breakout from the ESP32's 3.3 V output;
- connect a common ground;
- never apply 5 V to an ESP32 GPIO;
- connect SCLK, MOSI, MISO, and chip select with short jumper wires;
- begin at a conservative SPI clock.

Do not choose the final SD GPIOs merely from a convenient breadboard layout.
The audit must account for octal PSRAM, native USB, strapping pins, and onboard
devices. GPIO35, GPIO36, and GPIO37 are unavailable with this N16R8 module;
GPIO19 and GPIO20 are reserved while native USB is used. The first qualified
pin map remains experimental and belongs in its hardware report.

## USB and serial console

One USB-C data cable initially provides power, firmware flashing, and the
serial console. The Waveshare board's CH334 hub exposes two independent host
devices:

- the CH343 USB-to-UART bridge; and
- the ESP32-S3 native USB interface.

Use the CH343 USB-to-UART port as the first bring-up console. It remains
available independently of the application's native-USB configuration and can
show ROM and ESP-IDF boot messages when the application is not working. The
initial terminal settings are 115200 baud, eight data bits, no parity, one stop
bit, and no hardware or software flow control (`115200 8N1`).

On macOS, compare the `/dev/cu.*` device list before and after connecting the
board, then select the new CH343 device in CoolTerm or another ordinary serial
terminal. Pressing reset should produce a boot log. The canonical development
monitor may later be `idf.py monitor`, `espflash monitor`, or a repository
wrapper, but it uses the same byte stream.

Native USB is qualified separately. It may later carry the normal Triptych
serial console and USB/JTAG, but the machine contract does not depend on a USB
device name or on USB being the physical transport.

## Language and framework

The production direction is Rust over a pinned ESP-IDF release. The current
firmware links `triptych-cpu-core` and the allocation-free
`triptych-cpu-selftest` runner. ESP-IDF supplies startup, FreeRTOS, heap
capability allocation, the UART console, and diagnostics. Later stages add the
console and sector adapters for the complete machine.

ESP32-S3 uses Xtensa and currently requires the Espressif Rust and LLVM forks,
installed through `espup`, plus the Espressif GCC linker. The firmware project
pins those inputs, the `esp-idf-sys` family, the ESP-IDF release, flash and
PSRAM settings, and its own `Cargo.lock`.

A small C hardware probe will live under `tools/hardware-probes/esp32-s3-c/`.
It uses direct ESP-IDF and `idf.py` to identify the board and exercise USB,
flash, PSRAM, and microSD independently of Rust. The C probe is a diagnostic
control, not a second implementation of the Z80 machine.

PlatformIO and Arduino are not required. PlatformIO may later wrap development
commands for editor convenience, but Cargo and direct ESP-IDF commands remain
the reproducible build authorities.

## Toolchain setup

The standard repository workspace and ESP32 firmware use different Rust
toolchains. macOS and Linux developers can install the firmware inputs with:

```sh
cargo install espup --locked --version 0.17.1
espup install \
  --name triptych-esp \
  --targets esp32s3 \
  --toolchain-version 1.97.0.0 \
  --crosstool-toolchain-version 15.2.0_20250920
source "$HOME/export-esp.sh"
cargo install ldproxy --locked --version 0.3.2
cargo install espflash --locked --version 4.5.0
```

`tools/cpu-firmware-toolchain.json` records these versions and the ESP-IDF
commit. `firmware/cpu/Cargo.lock` pins the Rust dependency graph. The build
wrapper checks the complete `rustc` identity, `espflash` version, ESP-IDF
commit, and effective ESP-IDF configuration.

## Build

Each new shell must load the environment written by `espup` before building:

```sh
source "$HOME/export-esp.sh"
npm run build:cpu-firmware
```

The first build downloads and compiles the pinned ESP-IDF release in
`firmware/cpu/.embuild/`. That ignored directory is a local cache. Generated
ELF and binary files appear under `firmware/cpu/target/`; the merged image
contains the bootloader, partition table, and application.

The image reports this line before running the fixtures:

```text
TRIPTYCH-STAGE6 START format=1 fixtures=6
```

It follows with one pass or failure line per fixture and a final summary. Until
a physical board produces those lines, successful compilation is only a
build-and-link result. The retained macOS evidence and exact limitations are in
the [Stage 6 report](../../docs/reports/cpu-stage6-espidf-build.md).

## Resource policy

The initial conservative allocation is:

| Resource     | Initial use                                                                     |
| ------------ | ------------------------------------------------------------------------------- |
| Internal RAM | 64 KiB guest memory, CPU state, hot device state, task stacks                   |
| 8 MiB PSRAM  | trace history, snapshots, debugger storage, and larger caches after measurement |
| Flash        | firmware, boot ROM, configuration, and retained read-only assets                |
| microSD      | writable disk images and later CP/Mish media                                    |

PSRAM capacity alone does not prove that an allocation belongs there. A
hardware report must record the actual address, free internal memory, cache
behaviour, and execution impact before hot state moves out of internal RAM.

## Ownership and tasks

One FreeRTOS task initially owns the complete `Machine` value and is the only
code allowed to mutate guest-visible state. Serial, storage, or monitor work
may use drivers or additional tasks, but they communicate with the owner
through bounded messages. They must not retain raw pointers into machine state
or take locks around guest execution.

Core affinity, task priorities, queue sizes, and run-slice length remain
measurement decisions. The guest's T-state count comes from instruction
semantics; wall-clock pacing is applied between run calls and cannot change the
result of a deterministic fixture.

## Bring-up sequence

Before board arrival, the firmware must compile and link a serial-only
conformance self-test for ESP32-S3. That is a toolchain result only.

When the boards arrive:

1. Record the SKU, module suffix, board markings, USB device names, and ordered
   accessories.
2. Open the CH343 port at 115200 8N1, press reset, and retain the first complete
   ROM and ESP-IDF boot log.
3. Run the direct ESP-IDF C probe and record chip revision, reset reason, flash,
   PSRAM, free internal RAM, and repeat-boot stability.
4. Run the Rust equivalent and explain any disagreement.
5. Audit and wire the 3.3 V SPI microSD breakout.
6. Run destructive read, write, flush, restart, removal, bounds, and checksum
   tests on a scratch card containing no valuable data.
7. Run the Rust core's deterministic fixture digest over serial.
8. Boot the CPU machine, exercise serial and SD-backed records, flush, reset,
   and verify the persisted data.
9. Run the one-hour CPU-only endurance gate from the development plan.

Every physical result belongs in `docs/reports/` and records the board, module,
wiring, toolchains, firmware revision, measurement method, and whether the
result came from C or Rust. Host-model and compile-only proofs must not be
reported as ESP32 measurements.

## References

- [Waveshare board documentation](https://docs.waveshare.com/ESP32-S3-DEV-KIT-N8R8)
- [Waveshare microSD storage board](https://www.waveshare.com/product/micro-sd-storage-board.htm)
- [Espressif ESP32-S3 DevKitC-1 hardware reference](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/)
- [ESP-IDF ESP32-S3 programming guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/)
- [ESP-IDF external RAM guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/external-ram.html)
- [Rust on ESP toolchain installation](https://docs.espressif.com/projects/rust/book/getting-started/toolchain.html)
- [Rust-over-ESP-IDF template](https://github.com/esp-rs/esp-idf-template)
