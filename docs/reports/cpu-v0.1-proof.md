# ESP32-hosted Z80 SBC v0.1 proof report

Date: 2026-08-26

Revision baseline: `6db2538d`

Extraction note: this measurement was first produced in a Debug80 worktree
before the machine became the separate Triptych project. Triptych now owns the
machine contract and uses Debug80 Runtime only as an external development test
harness.

## Result

The version 0.1 CPU profile now has a written guest contract and an executable
Node reference implementation. A Z80 cold-boot proof uses the same ports and
ROM overlay intended for the ESP32-S3 CPU module. It loads a real CP/M 2.2
system image, removes the overlay, reaches the serial command prompt, runs a
`.COM` program, creates a file, reconstructs the provider from the flushed disk
image, and reads the file after the second cold boot.

This is a CP/M 2.2 compatibility proof using the repository's existing
CCP/BDOS. It is not the requested CP/Mish port. The compatibility run establishes
the machine boundary while the CP/Mish build and licence boundary remain
separate work.

## Frozen machine boundary

The normative profile is
[`docs/specifications/cpu-v0.1.md`](../specifications/cpu-v0.1.md).
Version 0.1 fixes these guest-visible choices:

- documented Z80 semantics at a nominal 4 MHz;
- flat 64 KiB RAM;
- a 256-byte read overlay at `$0000..$00FF`;
- raw serial at `$00..$01`;
- a 128-byte logical-record controller at `$10..$17` with a 512-byte backing
  cache line;
- system control at `$20`;
- VDP and sound reservations at `$40..$4F` and `$50..$57`.

Node callbacks, ESP32 task calls, FAT paths, and inter-module packets remain
below this boundary.

## Implemented reference components

The runtime implementation contains:

- a reset-controlled ROM overlay whose writes always reach underlying RAM;
- a byte serial device with receive-ready and transmit-ready status;
- a linear, 32-bit record address;
- private 128-byte write collection;
- four-record 512-byte cache lines;
- dirty-line replacement and explicit flush;
- a composed Z80 runtime that decodes the low eight port bits;
- optional transport-backed VDP and sound windows, inert when disconnected.

The compatibility boot sources are:

- `roms/cpu/bootstrap.asm`;
- `roms/cpu/bios.asm`.

The proof command is:

```sh
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img npm run proof:cpm22
```

## Measured compatibility run

The retained run produced:

| Account                                       |               Result |
| --------------------------------------------- | -------------------: |
| Boot ROM                                      |            256 bytes |
| CP/M compatibility BIOS                       |          1,024 bytes |
| First cold boot, `MAIN.COM`, and `SMOKE.COM`  | 111,877 instructions |
| First-run CPU time                            |   1,255,706 T-states |
| Second cold boot and persistent-file readback |  49,748 instructions |
| Second-run CPU time                           |     585,183 T-states |

At the nominal 4 MHz rate, the measured guest CPU work corresponds to about
314 ms for the first run and 146 ms for the second. These figures exclude host
storage latency because the Node block provider completes cache operations
synchronously.

The measured pre-extraction `MAIN.COM` printed `ESP32 SBC`. The current proof
prints `TRIPTYCH`. `SMOKE.COM` created `RESULT.TXT`; the second provider instance
read `CP/M file services are working` from the persisted image.

## Proof coverage

Eleven focused runtime tests distinguish:

- the first and last overlay bytes;
- writes beneath visible ROM;
- reset-only overlay restoration;
- exact memory-image sizes;
- each 128-byte quarter of a 512-byte backing sector;
- cache publication versus persistent publication;
- dirty-cache replacement;
- partial-write abort;
- capacity and first-invalid-record handling;
- protocol errors and unavailable drives;
- low-byte port decoding and the exact `$A5` overlay key;
- complete, non-overlapping VDP and sound windows with independent transport
  routing;
- Z80 execution from reset ROM through loaded RAM and flushed storage.

The end-to-end proof adds cold boot, BIOS disk translation, BDOS file creation,
`.COM` return, flush, provider reconstruction, and persistent readback.

## Defects found during the proof

Two initial boot-ROM designs failed because they treated overlaid addresses as
ordinary RAM:

1. `SP=$0100` placed a `CALL` return address at `$00FE`. The write reached RAM,
   but `RET` read ROM and returned to the wrong address.
2. Record counters stored in the ROM window received writes in RAM, while later
   reads still returned the ROM constants. The boot loop reloaded record zero.

The retained ROM places its stack at `$E300` and its two workspace bytes at
`$E2F0..$E2F1`. The regression proof now fails if either value moves back under
the overlay.

## CP/Mish gap

CP/Mish commit `1f60541b619c1e983f05e68a064c027d1cdeb113` is the selected upstream
baseline. Its current build requires `cpmtools`, `libz80ex`, and the Amsterdam
Compiler Kit; the upstream CI also installs Flex, Bison, Readline, and Lua. The
current host has none of the CP/M-specific tools or `libz80ex` package metadata.

Installing those host packages and building ACK would change the developer
environment, so this milestone did not perform that installation. The next
CP/Mish step belongs in a dedicated upstream checkout or a provenance-recorded
vendor workflow:

1. add a Triptych machine target;
2. link ZCPR1, ZSDOS, and a BIOS using the frozen serial and record ports;
3. make the boot-track layout an explicit build output;
4. retain the 256-byte ROM and high-RAM disable stub;
5. rerun the same prompt, `.COM`, write, flush, and cold-reboot proof against
   the CP/Mish image.

No VDP, sound, banked-memory, or common-service work is required before that
port.
