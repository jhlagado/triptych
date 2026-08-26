# ESP32-S3 Indexed-Colour VDP 0.1

## Status

This document fixes the logical interface for the executable model and the
finished Bitluni video module. It does not fix the SPI packet format, module
connector, ESP32 GPIO assignment, sprite budget, or raster-effects mechanism.

The principal game mode is **320×240, 8-bit indexed colour, with a 256-entry
RGB565 palette**. A byte in game VRAM is a palette index rather than a physical
colour:

```text
VRAM byte $2A -> palette[$2A] -> 16-bit RGB565 scanout colour
```

The Z80 therefore keeps the bandwidth and asset sizes of an eight-bit display
while a frame may use any 256 colours selected from the 65,536 RGB565 values.
Direct RGB332 remains a compatibility bitmap mode. Native 640×480 RGB565 is an
optional, lower-performance mode.

Version 0.1 implements VRAM transfer, blank, indexed bitmap, direct RGB332
bitmap, palette programming, and native RGB565 bitmap. Tile, sprite, text, and
raster renderers remain reserved until the hardware experiment establishes a
safe rendering budget.

## Settled design decisions

- Game pixels and direct-colour tile texels are one byte each.
- An 8×8 indexed tile occupies 64 bytes.
- Palette entries are packed RGB565 words.
- Palette index zero is visible in backgrounds and bitmaps. Sprite renderers
  may treat their configured transparent index, initially zero, as transparent.
- Palette and complete frame changes become visible only at vertical blank.
- The ESP32 compositor performs palette lookup; LCD_CAM does not.
- The physical DAC uses the complete 5:6:5 colour bus.
- Ordinary game modes never require the Z80 to transfer 16-bit pixels.
- The finished Bitluni board remains the video module; no replacement VGA DAC
  or custom VDP PCB is required.

## Hardware and software baseline

The video module is the finished Bitluni ESP32-S3 VGA board. It already
contains the ESP32-S3 N8R8, octal PSRAM, USB connection, VGA socket, sync
paths, and 16-bit resistor DAC. Development therefore concerns firmware and a
standard module connector, not reproduction of its video hardware.

Native ESP-IDF firmware uses the RGB LCD/GDMA, PSRAM, FreeRTOS, VSYNC callback,
SPI-slave, and diagnostic facilities. The VDP layer implements the
programmer-visible ports, VRAM, palette, frame publication, renderers, and SPI
transport endpoint.

The existing DAC supports both planned colour paths. The earliest scanout test
may place the RGB332 bits on eight DAC inputs and hold the other inputs low.
The compatibility renderer may instead replicate those bits across RGB565 to
reach the full analogue range; either mapping still contains only 256 distinct
source colours. Indexed RGB565 later assigns every DAC bit independently. None
of these firmware choices requires a wiring or board change.

FabGL remains prior art. Its timings, resistor-DAC practice, retrace handling,
terminal behaviour, and test programs are useful references. The firmware
does not adopt FabGL's API, display policy, sprite objects, Arduino dependency,
or original-ESP32 I2S VGA backend.

Espressif documents the principal bandwidth failure: if DMA cannot fetch data
in time, the RGB peripheral may emit dummy bytes and lose alignment until a
restart. PSRAM bandwidth, CPU contention, and recovery are therefore measured
properties rather than assumptions.

Sources:

- [ESP-IDF RGB LCD driver](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/lcd/rgb_lcd.html)
- [ESP-IDF SPI slave driver](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/peripherals/spi_slave.html)
- [ESP-IDF RGB driver implementation](https://github.com/espressif/esp-idf/blob/master/components/esp_lcd/rgb/esp_lcd_panel_rgb.c)
- [ESP32-S3 external RAM restrictions](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-guides/external-ram.html)
- [ESP32-S3 datasheet](https://www.espressif.com/sites/default/files/documentation/esp32-s3_datasheet_en.pdf)
- [Bitluni ESP32-S3 VGA board](https://bitluni.net/vga-s3)
- [Bitluni ESP32-S3 VGA software](https://github.com/bitluni/ESP32-S3-VGA)
- [FabGL repository](https://github.com/fdivitto/FabGL)

## Memory model

The intended optimized 320×240 path uses one indexed source buffer and two
logical-resolution RGB565 scanout buffers:

| Storage                     |              Size |
| --------------------------- | ----------------: |
| Indexed 320×240 framebuffer |      76,800 bytes |
| Front RGB565 320×240 buffer |     153,600 bytes |
| Back RGB565 320×240 buffer  |     153,600 bytes |
| 256-entry RGB565 palette    |         512 bytes |
| **Total**                   | **384,512 bytes** |

This arrangement assumes the proven hardware path can repeat each logical
pixel horizontally and each logical row vertically without storing a full
640×480 image. If the selected ESP-IDF/LCD_CAM path instead requires fully
expanded physical frames, each RGB565 scanout buffer is 614,400 bytes and the
equivalent total is 1,306,112 bytes. Both arrangements fit in 8 MiB PSRAM, but
they have different DMA and compositor costs. The hardware gate must determine
which arrangement is reliable; the smaller figure is not assumed merely from
capacity arithmetic.

A native 640×480 RGB565 source consumes 614,400 bytes. It is byte-addressed by
the Z80, little-endian, and has a minimum pitch of 1,280 bytes.

## Scanout and composition

The monitor receives VGA-compatible timing. In the game modes, each logical
320×240 pixel becomes a 2×2 physical block. The intended path is:

```text
indexed VRAM and game assets
             |
             v
dirty-region compositor: palette[index] -> RGB565
             |
             v
back RGB565 scanout buffer
             |
             v  vertical-blank swap
front RGB565 scanout buffer -> LCD_CAM/GDMA -> 16-bit DAC -> VGA
```

A complete 320×240 conversion at 60 frames per second visits 4.608 million
logical pixels per second. Dirty-region composition usually visits fewer.
Palette animation is cheap for the Z80 but invalidates every displayed pixel
whose index changed; changing the whole palette may therefore require a full
scanout regeneration.

Two implementation strategies must be benchmarked separately:

1. A logical 320×240 RGB565 DMA source whose pixels and rows are repeated by
   the scanout mechanism.
2. A standard 640×480 RGB565 DMA source filled by 2×2 expansion.

At a 25.175 MHz physical pixel clock, the second strategy has 36.864 MB/s of
active 16-bit payload. A reduced source-fetch figure is valid only if the
first strategy is demonstrated on the chosen peripheral configuration.

True mid-scanline palette changes are outside version 0.1. They require a
scanline renderer or tightly controlled DMA bounce buffers rather than the
frame-published palette described here.

## Resolution and mode policy

| Value | Mode                          | Source  | Bytes/pixel | 0.1 status    |
| ----: | ----------------------------- | ------- | ----------: | ------------- |
|     0 | blank                         | 320×240 |           — | implemented   |
|     1 | indexed bitmap                | 320×240 |           1 | primary       |
|     2 | indexed tile                  | 320×240 |           1 | reserved      |
|     3 | text                          | 640×480 |           — | reserved      |
|     4 | high-resolution RGB565 bitmap | 640×480 |           2 | experimental  |
|     5 | direct RGB332 bitmap          | 320×240 |           1 | compatibility |

The direct RGB332 renderer expands every source byte to RGB565 and does not
consult the programmable palette. It exists for simple bitmap software and
old assets; it is not the principal artistic mode.

## Logical port window

A machine profile assigns a 16-port-aligned base. The transport-neutral model
receives offsets zero through fifteen. The CPU ESP32 maps guest ports
`$40..$4F` to these offsets and transfers them to the Bitluni board over SPI.

| Offset | Name                | Read                             | Write                                   |
| -----: | ------------------- | -------------------------------- | --------------------------------------- |
|   `$0` | VRAM data           | byte, then increment             | byte, then increment                    |
|   `$1` | VRAM address low    | address bits 0–7                 | address bits 0–7                        |
|   `$2` | VRAM address middle | address bits 8–15                | address bits 8–15                       |
|   `$3` | VRAM address high   | address bits 16–23               | address bits 16–23                      |
|   `$4` | register select     | selected register                | select register                         |
|   `$5` | register data       | selected register byte           | selected register byte                  |
|   `$6` | status/command      | status                           | command                                 |
|   `$7` | palette index       | selected entry                   | select entry                            |
|   `$8` | palette data low    | programmed entry low byte        | stage low byte                          |
|   `$9` | palette data high   | programmed entry high byte       | commit word; optionally increment index |
|   `$A` | bulk FIFO           | `$FF` in 0.1                     | reserved; reports a transport error     |
| `$B–F` | reserved            | `$FF`; reports a transport error | reports a transport error               |

The VRAM address counter has 24 bits. An access beyond installed VRAM reads
`$FF` or discards the write, sets device error, and still advances the
counter. It never aliases low VRAM. The executable model defaults to 1 MiB.

## Registers

| Number    | Name                     | Publication rule                     | Reset |
| --------- | ------------------------ | ------------------------------------ | ----: |
| `$00`     | mode                     | immediate to programmed state        |     0 |
| `$01`     | border palette index     | immediate to programmed state        | `$00` |
| `$02`     | sprite transparent index | reserved for sprite stage            | `$00` |
| `$03`     | interrupt enable         | bit 0 vblank, bit 1 raster           | `$00` |
| `$04–$05` | VRAM increment           | high byte publishes the word         |     1 |
| `$06`     | palette control          | bit 0 auto-increment                 |     1 |
| `$10–$12` | bitmap base              | high byte publishes the 24-bit value |     0 |
| `$13–$14` | bitmap pitch in bytes    | high byte publishes the word         |   320 |

Low and middle bytes of a multi-byte register are staging bytes. Writing the
final high byte publishes the complete value to programmed state. The active
frame remains unchanged until command `$10` queues a valid configuration and
the next vertical blank applies it. Failed validation leaves active and
pending state unchanged.

A bitmap configuration is valid when its pitch can contain one source row and
its final visible byte lies inside installed VRAM:

```text
indexed/RGB332: base + 239 * pitch + 320  <= installedVramBytes
native RGB565:  base + 479 * pitch + 1280 <= installedVramBytes
```

## Palette protocol

Reset installs an RGB332-expanded palette so all 256 indexes are immediately
usable. This reset palette is merely a useful default; indexed mode is not
limited to those colours.

To program an entry, software selects its index, writes the low byte, then
writes the high byte. The high-byte write commits the complete RGB565 word to
the programmed palette. If auto-increment is enabled, the index advances
modulo 256 after the commit. Palette reads do not increment it.

Committed entries become active together at the next vertical blank. A low
byte by itself can never leak into the displayed palette. Palette publication
does not require the frame-queue command, and a palette change does not alter
VRAM indexes.

## Status and commands

| Status bit | Meaning                         |
| ---------: | ------------------------------- |
|          0 | vertical blank level            |
|          1 | raster interrupt pending        |
|          2 | a frame configuration is queued |
|          3 | VRAM transfer ready             |
|          4 | sprite overload                 |
|          5 | transport error                 |
|          6 | address or configuration error  |
|          7 | an enabled interrupt is pending |

Status reads have no acknowledgement side effect. Commands are `$01`
acknowledge vblank, `$02` acknowledge raster, `$03` acknowledge both, `$10`
queue the programmed frame, and `$20` clear errors. An unknown command sets
the transport-error flag.

## Executable proof boundary

The TypeScript model proves programmer-visible semantics without claiming
ESP32 timing:

- three-byte VRAM address carry and non-aliasing bounds errors;
- configurable and zero VRAM increments;
- atomic multi-byte register publication;
- atomic palette entry commits and vblank palette publication;
- palette auto-increment, disable, and wrap;
- visible background index zero;
- indexed RGB565 rendering and palette-independent RGB332 compatibility;
- vblank publication and atomic rejection of frame configurations;
- exact-boundary, little-endian 640×480 RGB565 rendering;
- status reads that preserve pending interrupts;
- distinct RGB888 and RGB565 expansion for every RGB332 byte.

The model resides at `src/video/vdp.ts`. The ESP32-hosted CPU profile assigns
base port `$40` and routes the module interrupt through a GPIO.

## Module connection

The first bench connection needs no breadboard or custom VGA circuitry. The
CPU and Bitluni boards require these shared signals:

| Signal    | Direction relative to VDP | Purpose                             |
| --------- | ------------------------- | ----------------------------------- |
| SCLK      | input                     | SPI clock from CPU module           |
| MOSI      | input                     | commands and VRAM writes            |
| MISO      | output                    | status and VRAM reads               |
| `/CS_VDP` | input                     | selects the video module            |
| `READY`   | output                    | receive transaction has been queued |
| `/IRQ`    | output                    | vblank, raster, or error interrupt  |
| GND       | —                         | common electrical reference         |
| reset     | input                     | optional module reset               |

Espressif recommends a handshake GPIO because the SPI host must wait until the
slave has queued a receive transaction. The GPIO matrix allows the SPI signals
to use available header pins. Exact GPIOs remain provisional until the board
schematic, VGA firmware, USB/JTAG use, and a running SPI test establish a
conflict-free assignment.

For flying-lead bring-up, each board may remain powered by its own USB cable.
Their grounds must be connected, while their 5 V and 3.3 V rails remain
separate. Initial SPI tests should use short leads and a conservative clock;
1–5 MHz is a bring-up range rather than the finished transport target.

A later passive carrier can provide keyed connectors, shared power, separate
video and sound chip selects, READY and interrupt lines, reset, and optional
22–47 ohm series resistors. It contains no VGA DAC or ESP32 circuitry.

A provisional 2×5 module connector can use this signal order:

| Pin | Signal       | Note                                   |
| --: | ------------ | -------------------------------------- |
|   1 | GND          | common reference                       |
|   2 | SCLK         | shared SPI clock                       |
|   3 | MOSI         | shared host-to-device data             |
|   4 | MISO         | shared device-to-host data             |
|   5 | `/CS_VDP`    | module-specific select                 |
|   6 | `READY`      | module-specific handshake              |
|   7 | `/IRQ`       | module-specific interrupt              |
|   8 | reset        | optional; may connect to board `EN`    |
|   9 | module power | disconnected while each board uses USB |
|  10 | spare        | reserved                               |

This is a signal allocation, not a frozen connector orientation or voltage
specification. The carrier design must add keying and an unambiguous pin-one
mark before a shared supply is connected.

## Hardware acceptance gate

Tile and sprite implementation waits until the Bitluni board passes a
continuous 30-minute run:

1. Native ESP-IDF produces VGA-compatible timing without Arduino or FabGL.
2. Timing remains locked on two materially different displays.
3. Direct RGB332 produces the expected 256 colours while unused DAC bits remain
   inactive.
4. A 320×240 test card expands to exact 2×2 pixels without a shifted line.
5. Indexed test pixels map through all 256 programmable RGB565 entries.
6. Palette changes become visible on one frame boundary without mixed entries.
7. Bitmap paths remain stable during continuous VRAM writes over the prototype
   SPI transport.
8. Deliberate PSRAM contention remains within budget or produces a counted
   fault followed by clean VSYNC recovery.
9. The logical-buffer and fully expanded scanout strategies are measured; the
   firmware records which one meets the stability gate.
10. Native 640×480 RGB565 is labelled optional unless it passes the same test.
11. READY prevents the CPU master from starting an unqueued slave transaction,
    and reads return the response for the requested logical port.

Every run records the ESP-IDF version, module, PSRAM mode and clock, CPU clock,
pixel clock, buffer arrangement, free internal DMA RAM, underrun and recovery
counts, full-frame and dirty-region compositor times, and worst scanline fill
time.

The remaining physical decisions are the module connector, GPIO assignment,
power distribution, optional signal damping, and reset wiring. SPI framing and
interrupt-vector policy remain firmware contracts. A physical Z80 bus adapter
is outside the intended ESP32-emulated CPU machine.
