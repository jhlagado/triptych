# ESP32-hosted Z80 SBC v0.1 machine profile

Status: active experimental contract

Date: 2026-08-26

## Purpose and authority

This profile defines the first CPU module for the modular Triptych computer. An
ESP32-S3 initially executes the guest CPU and provides memory, serial I/O, and
SD-backed disks. Finished ESP32 modules provide video and sound over SPI. The
CPU is expected to remain an ESP32-hosted Z80 emulator; a physical Z80 is a
distant, optional extension rather than a constraint on the first machine.

The authority order is:

1. documented Z80 instruction, flag, reset, interrupt, and I/O semantics;
2. this machine profile;
3. the CP/Mish machine BIOS;
4. ESP32 and host reference implementations.

ESP32 task calls, Node callbacks, FAT paths, and SPI packets are not part of the
guest contract. The logical Z80 port operations are the boundary. The profile
intentionally does not define the common firmware-service ABI, bank switching,
or the contents of the separately specified VDP and sound registers.

## Frozen version 0.1 profile

| Property                  | Version 0.1 value                             |
| ------------------------- | --------------------------------------------- |
| Guest CPU                 | documented Z80 instruction set                |
| Initial nominal clock     | 4 MHz, selectable by the provider             |
| I/O decoding              | low eight bits of the 16-bit Z80 port address |
| Address space             | flat 64 KiB guest RAM                         |
| Reset PC                  | `$0000`                                       |
| Reset interrupt state     | IM 0, IFF1 clear, IFF2 clear                  |
| Boot overlay              | 256-byte ROM at `$0000..$00FF` for reads      |
| Disk guest record         | 128 bytes                                     |
| Disk backing-cache line   | 512 bytes, four guest records                 |
| Initial console           | byte-oriented serial terminal                 |
| Initial interrupt sources | none; polling only                            |

The 4 MHz rate is a compatibility baseline, not an ESP32 performance claim.
The provider may run faster or unpaced for tests. Software must not infer time
from instruction throughput.

## Module topology and peripheral transport

The intended machine uses three completed modules:

```text
CPU ESP32
  Z80 emulator, CP/M memory and BIOS, SD storage, keyboard and console
       |
       +-- SPI --> Bitluni ESP32-S3 VDP --> VGA
       |
       +-- SPI --> sound ESP32 --> I2S audio module
```

The CPU ESP32 is the SPI host. The VDP and sound boards are SPI devices with
separate chip-select signals. They may share SCLK, MOSI, and MISO if the final
backplane layout and firmware prove that arrangement reliable.

The CPU provider translates a guest `OUT` into an ordered logical-port write.
A guest `IN` blocks until its logical-port read returns. The physical provider
may combine adjacent transfers or use a bulk packet, but the result must match
the byte operations and publication rules of the guest-visible device.
Completed writes must remain in issue order, and a read must observe every
earlier completed write.

Each SPI device has a `READY` handshake because an ESP32-S3 SPI slave may not
have a receive transaction queued when the host first attempts a transfer.
Video and sound interrupt outputs use separate GPIOs. The CPU provider samples
those lines and requests an emulated Z80 interrupt; interrupt mode, priority,
and vector allocation remain outside version 0.1.

No raw address bus, data bus, `/IORQ`, `/RD`, `/WR`, or `/WAIT` signal crosses
the module backplane. A future physical Z80 would require a separate bus-to-SPI
adapter on the CPU side. That adapter would not change the VDP or sound module.

## Reset and memory

Reset makes the boot ROM visible for reads at `$0000..$00FF`. Writes in that
range always reach the underlying RAM, even while ROM reads are enabled. This
allows the boot code to construct page-zero state before removing itself.

Writing `$A5` to `SYSTEM_CONTROL` disables the overlay. Other values do
nothing. The overlay cannot be re-enabled by guest software; only machine reset
does so. Disabling the overlay changes the next memory read, including an
instruction fetch. Boot code must therefore execute the disabling `OUT` from a
location whose following bytes are identical in ROM and RAM, or jump from code
outside the overlay.

Machine reset resets the CPU and device-controller state and makes the ROM
visible again. It does not promise to clear RAM or flush a dirty disk cache.
Power-on RAM contents are unspecified. Boot firmware must initialize every byte
on which it depends.

## Port map

Unassigned ports read as zero and ignore writes. The host reference routes the
external windows through optional synchronous transport providers; without a
provider they remain inert.

| Low port range | Device                                   |
| -------------- | ---------------------------------------- |
| `$00..$01`     | serial console                           |
| `$10..$17`     | logical-record disk controller           |
| `$20..$27`     | system control and future bank registers |
| `$40..$4F`     | external VDP logical ports               |
| `$50..$57`     | external sound logical ports             |

### Serial console

| Port                  | Read                               | Write             |
| --------------------- | ---------------------------------- | ----------------- |
| `$00` `SERIAL_DATA`   | dequeue one received byte, or zero | transmit one byte |
| `$01` `SERIAL_STATUS` | status bits                        | ignored           |

Serial status bit 0 means receive data is available. Bit 1 means transmit is
ready. Version 0.1 always reports transmit ready. All other bits are zero. Guest
software implements echo and line editing.

The wire boundary remains an unstructured byte stream. Interactive host UIs
provide an 80-column by 24-row ANSI terminal profile so the same full-screen
software works in the browser, a native macOS/Linux terminal, and an external
terminal connected to the eventual ESP32 USB serial port. The required output
subset is printable 7-bit ASCII, `BEL`, `BS`, `HT`, `LF`, `CR`, automatic wrap,
scrolling, `CSI A/B/C/D`, `CSI H/f`, `CSI J/K` modes 0, 1, and 2, and `CSI m`
attributes 0, 1, 4, and 7. Positions are one-based and clamped to the screen;
unsupported escape sequences are consumed without displaying their bytes.

Interactive input sends bytes without local echo. Return sends `CR`, Backspace
sends `BS`, Delete sends `DEL`, and the arrow keys send `ESC [ A`, `ESC [ B`,
`ESC [ C`, and `ESC [ D`. A headless host may expose the raw byte queues without
implementing a screen. This terminal profile changes no serial port, status
bit, transport, or CPU-core behavior.

### System control

| Port                   | Read                                          | Write                       |
| ---------------------- | --------------------------------------------- | --------------------------- |
| `$20` `SYSTEM_CONTROL` | bit 0 is one while boot ROM reads are enabled | `$A5` disables the boot ROM |

Ports `$21..$23` are reserved for machine identity and clock control. Ports
`$24..$27` are reserved for four future 16 KiB bank selectors. They have no
effect in the flat-memory profile.

## Logical-record disk controller

The guest addresses 128-byte logical records with a 32-bit record number. The
controller translates four adjacent records to one 512-byte backing-sector
cache line. CP/M can use record numbers directly; another operating system may
combine records into larger blocks.

| Port  | Read              | Write             |
| ----- | ----------------- | ----------------- |
| `$10` | status            | command           |
| `$11` | selected drive    | selected drive    |
| `$12` | record bits 0-7   | record bits 0-7   |
| `$13` | record bits 8-15  | record bits 8-15  |
| `$14` | record bits 16-23 | record bits 16-23 |
| `$15` | record bits 24-31 | record bits 24-31 |
| `$16` | next read byte    | next write byte   |
| `$17` | error code        | ignored           |

Commands are:

| Value | Command        | Result                                                     |
| ----: | -------------- | ---------------------------------------------------------- |
|     1 | `READ_RECORD`  | expose 128 bytes through the data port                     |
|     2 | `WRITE_RECORD` | accept 128 bytes, then publish them atomically to cache    |
|     3 | `FLUSH`        | write the dirty cache line to persistent backing storage   |
|     4 | `GET_CAPACITY` | replace the record register with the drive size in records |

Status bits are:

| Bit | Meaning                                               |
| --: | ----------------------------------------------------- |
|   0 | busy                                                  |
|   1 | data request: exactly one 128-byte transfer is active |
|   2 | error; inspect `$17`                                  |
|   3 | selected drive is write protected                     |
|   4 | selected drive is present                             |
|   5 | the controller cache is dirty                         |
|   6 | controller ready                                      |
|   7 | reserved                                              |

The host reference completes media operations synchronously, so it does not
assert busy. ESP32 and physical implementations may assert busy while keeping
the same command completion and data-request semantics. Software must poll.

Error codes are zero for no error, then unavailable drive, out-of-range record,
bad command, bad transfer state, write protection, and provider I/O failure.
A successful command clears the previous error.

A read command validates the complete address before exposing data. A write
command collects all 128 bytes privately and changes neither cache nor media
until the final byte arrives. Reset, another command, or a protocol error aborts
an incomplete transfer. Replacing a dirty 512-byte cache line first writes that
line to the backing image. `FLUSH` is the guest's explicit durability boundary;
CP/M warm boot and orderly shutdown must issue it.

`GET_CAPACITY` reports the count of addressable 128-byte records. Record zero
is the first record and `capacity - 1` is the last.

## CP/Mish placement

The first CP/Mish port will retain a large transient area and place its static
components at the top of RAM. Exact CCP, BDOS, and BIOS addresses are outputs of
the CP/Mish build and are not frozen here. The required conventional entries
remain `$0000` for warm boot, `$0005` for BDOS, and `$0100` for `.COM` programs.

The boot ROM reads the system records from drive 0, places the linked CP/Mish
image at its build-selected high-memory address, initializes page zero, removes
the ROM overlay, and enters the BIOS cold-boot routine. The BIOS alone converts
CP/M track and sector requests into this profile's linear record numbers.

CP/Mish is tracked from upstream commit
`1f60541b619c1e983f05e68a064c027d1cdeb113` for the first port. It uses ZSDOS,
ZCPR1, and a machine BIOS; it is an aggregate distributed under GPLv2. A future
vendored or generated artifact must record component provenance and licences.

## Required version 0.1 proofs

- reset fetches the first instruction from ROM at `$0000`;
- writes beneath the overlay become visible after `$A5` is written to `$20`;
- no other control value removes the overlay;
- reset makes the overlay visible again without silently publishing an
  incomplete disk write;
- the first and last byte of RAM and ROM-overlay regions are distinguished;
- all four 128-byte records in one 512-byte cache line address the correct
  quarter;
- a partial write changes neither cache nor persistent media;
- dirty-cache replacement and explicit flush preserve the other three records;
- record zero and `capacity - 1` work; `capacity` fails without wraparound;
- serial input, output, and status decode through any Z80 upper port byte;
- all sixteen VDP offsets and all eight sound offsets route to separate
  transports without overlap;
- the Z80 executes the boot ROM, removes the overlay, and executes a loaded RAM
  image;
- CP/Mish cold boots over serial, runs a `.COM` file, and returns to ZCPR1;
- a guest disk write remains after flush and a fresh provider instance.

The final two proofs are the milestone discriminator. VDP, sound, banked RAM,
timer interrupts, and the common firmware-service ABI do not precede them.
