# Triptych architecture

Triptych separates the computer into CPU, video, and sound modules. Each
module has its own processor and timing domain. The guest sees Z80 memory and
I/O operations rather than ESP32 calls, SPI packets, FreeRTOS tasks, or device
driver APIs.

```text
                         logical Z80 I/O
                       carried by private SPI

CPU module  --------------------------------->  video module  ----> VGA
 Z80 host     \
 RAM           +---------------------------->  sound module  ----> I²S audio
 storage
 console
```

The CPU module is the SPI host. Video and sound use separate chip-select,
ready, and interrupt signals. The private transport may batch adjacent byte
operations when the result remains identical to the documented logical-port
sequence.

## Contract boundary

The specifications define the stable side of the experiment:

- [CPU profile](specifications/cpu-v0.1.md)
- [video processor](specifications/video-v0.1.md)
- [sound processor](specifications/sound-v0.1.md)

Register layouts marked experimental may change after measurement. The broad
architecture remains fixed unless hardware evidence shows that another design
preserves video timing, audio continuity, and module replaceability more
reliably.

## Implementation state

The repository contains executable TypeScript reference models, Z80 boot
sources, a portable Rust CPU machine, native and WebAssembly hosts, and a
standalone Rust-over-ESP-IDF CPU firmware image. The ESP32 image links the same
core and reports checked fixture digests through the default UART. This proves
the build boundary only. PCB or carrier designs, pin assignments, boot results,
and continuous hardware measurements remain future milestones.

## Current CPU implementation direction

Implementation is currently limited to the CPU module. Video and sound retain
their independent specifications and reserved logical ports but are not part
of the CPU schedule.

The CPU machine has one portable Rust core with native macOS/Linux,
browser/WebAssembly, and ESP32-S3 hosts. The core owns guest-visible execution,
memory, ports, reset, and cycle accounting. Hosts own terminals, disk-image or
microSD access, wall-clock pacing, and user interfaces. The existing TypeScript
model remains a semantic oracle while the Rust implementation is proved; it is
not a production dependency.

The native `triptych-cpm` utility owns development-time CP/M directory and
allocation policy. It creates 512-byte-sector-padded working images and moves
named files between macOS and user 0 of the CP/M filesystem. It does not expose
a second guest disk protocol, participate in CPU execution, or enter the
portable core. The native host continues to see only complete 512-byte sectors.

A small development-only C image will establish a direct ESP-IDF hardware
baseline for the Waveshare ESP32-S3 board. It will not contain a second Z80
machine. The detailed dependency order, toolchain gates, conformance fixtures,
and physical bring-up procedure are in the
[CPU development plan](plans/cpu-development.md).
