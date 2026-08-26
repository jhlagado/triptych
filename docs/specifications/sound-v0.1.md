# ESP32 programmable sound processor reference contract

## Status and authority

This document specifies Triptych's host-side sound reference model. It turns
the architectural sound handoff into an
executable candidate for firmware work. The handoff remains authoritative for
the settled system architecture:

- sound begins on a separate ESP32 module;
- Z80 software controls logical ports and registers;
- the sound processor renders independently of the Z80;
- the CPU ESP32 reaches the module over SPI while packet details remain below
  the guest contract;
- oscillator playback never requires one Z80 operation per sample.

The encodings below are experimental. Tests may establish their behaviour, but
they do not fix the machine's numeric base port, ESP32 model, I²S device,
transport framing, physical interrupt wiring, filter design, or eventual
video/audio integration.

## Reference-model scope

The model renders signed 16-bit interleaved stereo at 48 kHz. It contains eight
synthesized voices, two PCM voices, a master-volume register, a 24-bit sound-RAM
cursor, and 256 bytes each of shadow and active register storage. Sound RAM is
1 MiB by default and can be smaller in a proof fixture.

All synthesis uses integer arithmetic. The mixer saturates each output channel
to `-32768..32767`; it does not wrap. The implementation has no filter,
resampler, anti-aliasing stage, event FIFO, or transport parser.

## Logical port window

A machine profile selects the base port. The reference adapter decodes the low
byte of a Z80 I/O address and maps these offsets:

| Offset | Read                             | Write                                       |
| ------ | -------------------------------- | ------------------------------------------- |
| `+0`   | sound RAM at the current address | sound RAM at the current address            |
| `+1`   | address bits 0–7                 | address bits 0–7                            |
| `+2`   | address bits 8–15                | address bits 8–15                           |
| `+3`   | address bits 16–23               | address bits 16–23                          |
| `+4`   | selected register                | register select                             |
| `+5`   | selected shadow byte             | selected shadow byte                        |
| `+6`   | status                           | command                                     |
| `+7`   | zero                             | reserved; a write reports a transport error |

Every sound-RAM data access increments the 24-bit address modulo `2^24`. An
access beyond installed RAM returns zero on a read or discards a write, sets
the overflow flag, and still increments the address. Thus the final installed
byte remains accessible and the first byte beyond it has deterministic fault
behaviour.

## Commands and publication

| Value | Command        | Boundary                    |
| ----- | -------------- | --------------------------- |
| `$01` | `APPLY_ALL`    | next `renderBlock` boundary |
| `$7F` | `RESET`        | immediate                   |
| `$80` | `CLEAR_STATUS` | immediate                   |

Register-data writes change shadow storage only. `APPLY_ALL` marks a pending
commit; the renderer copies all 256 shadow bytes to active storage before the
first sample of the next block. A partially written phase increment, address,
or group of voices can never become active.

`RESET` clears sound RAM, both register files, phase and envelope state, PCM
cursors, and sticky status. It then restores master volume to `$FF`. All voices
remain disabled, so output is silent. `CLEAR_STATUS` clears completion and fault
flags. A recognized command sets `command accepted`; an unrecognized command
sets `transport error`.

## Register map

Register `$00` contains master volume. Values `$00` and `$FF` mean silence and
full scale. Registers `$01..$0F` are reserved.

Each synthesized voice has a 16-byte bank. Voice 0 begins at `$10`, voice 1 at
`$20`, through voice 7 at `$80`.

| Bank offset | Width   | Field                                 |
| ----------- | ------- | ------------------------------------- |
| `+0`        | 4 bytes | 32-bit phase increment, little-endian |
| `+4`        | 2 bytes | pulse width, little-endian            |
| `+6`        | 1 byte  | control                               |
| `+7`        | 1 byte  | attack rate                           |
| `+8`        | 1 byte  | decay rate                            |
| `+9`        | 1 byte  | sustain level                         |
| `+A`        | 1 byte  | release rate                          |
| `+B`        | 1 byte  | volume                                |
| `+C`        | 1 byte  | pan                                   |
| `+D..+F`    | 3 bytes | reserved                              |

The synth control byte uses bit 0 for enable, bit 1 for gate, and bits 2–3 for
waveform: 0 pulse, 1 sawtooth, 2 triangle, and 3 noise. Other bits are reserved.

PCM channel 0 begins at `$90`; channel 1 begins at `$A0`.

| Bank offset | Width   | Field                                    |
| ----------- | ------- | ---------------------------------------- |
| `+0`        | 3 bytes | start address, little-endian             |
| `+3`        | 3 bytes | loop address, little-endian              |
| `+6`        | 3 bytes | end address, little-endian and exclusive |
| `+9`        | 4 bytes | Q16.16 source-sample phase increment     |
| `+D`        | 1 byte  | control                                  |
| `+E`        | 1 byte  | volume                                   |
| `+F`        | 1 byte  | pan                                      |

PCM control bit 0 enables playback, bit 1 enables looping, and bit 2 selects
signed 8-bit source data. With bit 2 clear, source bytes are unsigned and `$80`
is zero. A phase increment of `$00010000` consumes one source byte per output
sample.

## Oscillator and envelope arithmetic

The renderer obtains a waveform sample from the current phase, then adds the
unsigned 32-bit phase increment modulo `2^32`. The represented frequency is:

```text
frequency = phaseIncrement × 48000 / 2^32
```

The runtime exports conversions for building Z80 note tables. For example,
440 Hz becomes phase increment `39,370,534`, whose represented frequency is
approximately 440.000005 Hz.

Pulse output is `+32767` while the high 16 phase bits are below pulse width and
`-32768` otherwise. A width of zero is always low. Sawtooth starts at `-32768`
and rises with the high 16 phase bits. Triangle rises from `-32768` to `32767`
and then falls. The xorshift32 noise generator advances on phase wrap, so its
rate follows the phase increment rather than the 48 kHz output clock.

The envelope level is unsigned 16-bit. Sustain expands an 8-bit register by
multiplying it by 257. A zero attack, decay, or release rate completes that
stage immediately. Every nonzero rate gives the time for a full-scale linear
slope:

```text
full-scale slope duration = rate × 256 samples
```

At 48 kHz, rate 1 is about 5.33 ms and rate 255 is 1.36 s. A gate rise enters
attack from the current level. A gate fall enters release from the current
level. This rule covers retriggering during release and release during attack
or decay without a discontinuous level reset.

## PCM boundaries

Start is inclusive and end is exclusive. Enabling a channel starts at its start
address. Changing start, loop, end, or phase increment while enabled restarts
the channel at the next apply boundary; volume, pan, signedness, and loop-mode
changes do not restart it.

At end, a valid loop continues at the programmed loop address. A valid loop is
within `[start, end)`. Without one, the channel disables itself after emitting
the final source sample and sets its completion flag. A later `APPLY_ALL` for
unrelated registers does not restart a completed channel. Software can replay
it by applying enable clear and then applying enable set. Disabling a channel
at an apply boundary makes the next block silent.

## Gain and pan

Voice volume and master volume are linear unsigned bytes. Pan is also linear:
`$00` is hard left and `$FF` is hard right. The centre values divide a source
between the channels; the reference model does not use a constant-power curve.
Each source is scaled before accumulation, master volume is applied to the sum,
and the final value is saturated to signed 16-bit.

## Status

| Bit | Meaning                                 |
| --- | --------------------------------------- |
| 0   | audio engine running                    |
| 1   | command accepted                        |
| 2   | PCM channel 0 completed                 |
| 3   | PCM channel 1 completed                 |
| 4   | sound-RAM access exceeded installed RAM |
| 5   | invalid command or reserved-port write  |
| 6   | underrun reported by the audio host     |
| 7   | interrupt cause pending                 |

PCM completion, overflow, transport error, and underrun set bit 7. Reading
status does not acknowledge any flag. `CLEAR_STATUS` provides explicit
acknowledgement.

## Current proof boundary

Automated tests establish shadow-register atomicity, 32-bit phase wrap,
representative frequency conversion, all four waveforms, gate changes during
every ADSR phase, volume and pan endpoints, eight-voice saturation, final-byte
sound-RAM access, address carry, explicit status acknowledgement, PCM end and
loop handling, reset silence, and programming through real Z80 `OUT (n),A`
instructions. These tests prove the reference semantics only.

Hardware work still requires measurements of I²S scheduling margin, DMA buffer
placement, oscillator and mixer cost on the chosen ESP32, simultaneous video
and SPI traffic, analogue output quality, and recovery from malformed SPI
packets. Those measurements should precede a choice of ESP32 model, DAC, audio
block size, or module connector.
