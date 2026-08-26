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

The repository currently contains executable TypeScript reference models and
Z80 boot sources. These prove address boundaries, atomic publication, routing,
rendering, synthesis, storage, and reset behaviour. ESP-IDF firmware, PCB or
carrier designs, pin assignments, and continuous hardware measurements remain
future milestones.
