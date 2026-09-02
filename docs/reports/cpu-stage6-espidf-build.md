# CPU Stage 6 ESP-IDF build report

Status: complete; macOS and clean Ubuntu compile, link, and image proofs
retained

Date: 2026-08-31

## Result

The portable Rust CPU core now links into a standalone ESP32-S3 firmware image.
The image runs the six checked CPU conformance fixtures and reports one stable
result line per fixture through ESP-IDF's default UART console. The firmware
does not contain SD, video, sound, GPIO, native-USB, or inter-module transport
code.

Both the macOS arm64 build and a fresh Ubuntu arm64 build produced a
417,920-byte application image and a 483,456-byte merged bootloader,
partition-table, and application image. The merged image uses the ESP-IDF
single-large-app layout; the application occupies 27.21% of its 1,536,000-byte
partition.

These are build results. No ESP32 board was connected, so this report does not
claim that the image boots, that UART output appears, that PSRAM is present, or
that any timing or memory figure has been measured on hardware.

## Firmware boundary

`triptych-cpu-selftest` embeds generated Rust constants derived from the six
checked JSON fixtures:

- `boot-overlay-serial`;
- `cold-boot-disk-persistence`;
- `flags-conditional-timing`;
- `interrupt-im1`;
- `reset-defined-state`;
- `serial-read-order`.

The runner uses fixed-capacity buffers and takes the 64 KiB guest RAM from its
caller. Native tests compare the complete typed result and its canonical
SHA-256 digest for every fixture. The ESP32 host allocates that RAM with
`MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT`, then passes the unique mutable buffer
to the same runner. ESP-IDF and allocation calls remain in
`firmware/cpu/src/main.rs`; the portable core contains no ESP-IDF dependency.

The serial protocol begins with:

```text
TRIPTYCH-STAGE6 START format=1 fixtures=6
```

It then emits `TRIPTYCH-FIXTURE PASS` or `TRIPTYCH-FIXTURE FAIL` lines and a
final summary. This is a machine-readable bring-up protocol, not the guest's
serial console.

## Architecture decision

Two viable host shapes were compared before implementation:

1. a Cargo-first Rust binary using `esp-idf-sys`; and
2. an `idf.py`/CMake application linking a Rust static library.

The Cargo-first host was selected because Stage 6 contains only one thin native
boundary and the portable production core is already a Rust crate. Direct
`esp-idf-sys` calls avoid adding the larger `esp-idf-svc` facade before a driver
is required. A later C hardware probe remains independent and uses direct
ESP-IDF as a diagnostic control. If Rust integration develops a concrete
toolchain or driver limitation, the portable core can still be linked through
a C ABI without changing the guest contract.

## Pinned inputs

The machine-readable list is `tools/cpu-firmware-toolchain.json`; the firmware
has its own `Cargo.lock`. The important selections are:

| Input              | Selection                                                       |
| ------------------ | --------------------------------------------------------------- |
| Target             | `xtensa-esp32s3-espidf`                                         |
| Xtensa Rust        | `1.97.0.0`                                                      |
| `rustc` identity   | `1.97.0-nightly`, commit `8ea53bcd7`, release marker `1.97.0.0` |
| `espup`            | `0.17.1`                                                        |
| `espup` GCC/tools  | `15.2.0_20250920`                                               |
| ESP-IDF linker GCC | `14.2.0_20260121`                                               |
| `ldproxy`          | `0.3.2`                                                         |
| `espflash`         | `4.5.0`                                                         |
| `esp-idf-sys`      | `0.37.2`                                                        |
| `embuild`          | `0.33.3`                                                        |
| ESP-IDF            | v5.5.5, commit `b774170ff46c393eeb5e495ea37936038d3f4f4f`       |

`embuild` uses tag mode so Git clones the tag's matching recursive submodule
revisions. The repository build wrapper separately rejects a managed checkout
whose `HEAD` does not equal the recorded commit.

## Effective configuration

The build wrapper reads ESP-IDF's generated `sdkconfig.json` and rejects a
build unless it confirms the required settings. The retained build had:

- ESP32-S3 target, 16 MiB flash, QIO application mode, and 80 MHz flash;
- octal PSRAM initialization and memory test at 80 MHz;
- capability-only PSRAM allocation, with ordinary `malloc` kept internal;
- failure when PSRAM initialization fails;
- UART0 at 115200 baud with no secondary console;
- a 16 KiB ESP-IDF main-task stack;
- print-and-halt panic handling;
- the single-large-app partition table; and
- ESP-IDF reproducible-build metadata enabled.

The flash header uses DIO because ESP-IDF's bootloader starts in DIO and then
enables QIO. The QIO selection remains present in the generated configuration.
The paper configuration expects 16 MiB quad flash and 8 MiB octal PSRAM, but
only Stage 7 can verify the delivered modules.

## Retained macOS evidence

The wrapper recorded the following release build:

| Artifact           | Bytes     | SHA-256                                                            |
| ------------------ | --------- | ------------------------------------------------------------------ |
| ELF                | 5,814,612 | `d1d881c1acfc30c19347626b23fc1979e517f824183492cca6c77910c32e9a96` |
| Application image  | 417,920   | `d45d099b06175f71fc7cb9aa4cf226d5812025a5d1f7fbcafb52b58442c16e3a` |
| Merged flash image | 483,456   | `c2c4297d1fda9aca8083dd220673109a098d32a480aee7c0382851c97bb651c5` |

GNU `size` reported 329,723 bytes of text, 88,084 bytes of data, and 828,037
bytes of BSS. The BSS total includes ESP-IDF linker regions and reserved
external-memory address space; it is not a measurement of boot-time internal
RAM use. The generated `target/stage6/build-evidence.json` retains the complete
section listing locally, while this report retains the reviewable summary.

The standard repository check covers generator freshness, native fixture
execution, Rust formatting and Clippy, all host tests, and the WASM build. The
ESP-IDF build remains a separate command because it requires the Espressif
Xtensa toolchain and downloads a substantial managed ESP-IDF environment.

## Retained Linux evidence

The Linux proof ran in a new Lima virtual machine with Ubuntu 26.04 LTS,
Linux 7.0.0-28-generic, arm64, four virtual CPUs, and 4 GiB of RAM. A
source-only copy excluded Git metadata, dependencies, and generated build
directories. Before the build, 108 source files in that copy had the same
combined path-and-content SHA-256 digest as the host source:
`144844784f71b8e28759f9c248b2b7ecac4aa7b6d8f0b2901c6cd9b4faea3ce2`.

The VM received the pinned release binaries directly. Their downloaded ZIP
files had these SHA-256 digests:

| Tool       | SHA-256                                                            |
| ---------- | ------------------------------------------------------------------ |
| `espup`    | `9b0082414a962edfdd62aeebba07e8eaf3009477e78903a6bc656775f2f1dbe7` |
| `ldproxy`  | `4921860cc83a42bbc80d5b7090b5fac4b7b12ed7d133547bd888adb96700075c` |
| `espflash` | `2d5972b9c18fc89bf253e60fe6df6a4f8db3aee5db0166b2c97b53bd21c01f09` |

`espup` installed the pinned Xtensa Rust and GCC toolchains. The subsequent
`node tools/build-cpu-firmware.mjs` run started without a Cargo target tree or
managed ESP-IDF checkout and completed in 6 minutes 9 seconds. The resulting
ESP-IDF checkout was clean at the required commit.

| Artifact           | Bytes     | SHA-256                                                            |
| ------------------ | --------- | ------------------------------------------------------------------ |
| ELF                | 5,813,752 | `9cae131bcdd8ef5fdc9448afb2b4d519ad826bafd6503c04c63ac4c7f0289ecf` |
| Application image  | 417,920   | `46f071c92eee72c9dd586fb863f80f679336e18c7b12d8e8167fce31f178af39` |
| Merged flash image | 483,456   | `8e296d5bb3468122f3e8ac374d7abe2b5ce8c64a3c698596fda66e627bfd0545` |

GNU `size` again reported 329,723 bytes of text, 88,084 bytes of data, and
828,037 bytes of BSS. The effective ESP-IDF configuration passed the same
wrapper checks as the macOS build.

The application and merged-image lengths, section totals, and effective
configuration match across the two hosts. Their SHA-256 digests do not match,
and the Linux ELF is 860 bytes smaller. Stage 6 therefore proves clean
cross-host construction of flashable images, not bit-for-bit reproducible
artifacts. Debug paths and other host-specific build metadata are the likely
source of the difference, but that cause has not been proved.

`.github/workflows/cpu-firmware.yml` defines the same clean Linux build and
uses an immutable checkout-action commit. It has not run because this local
repository has no Git remote. The independent local Linux proof satisfies the
two-host Stage 6 exit; a future hosted run remains useful CI coverage rather
than an exit condition.

## Next measurement

Stage 7 begins when a Waveshare board arrives. The first run records board and
module markings, the CH343 device name, the complete reset log, detected flash
and PSRAM, and repeated-boot behaviour. A direct ESP-IDF C probe supplies the
control result before the Rust image is judged.
