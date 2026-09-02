# Triptych CPU core architecture

Status: selected for Stage 2 implementation

Date: 2026-08-31

## Decision

`triptych-cpu-core` is a deterministic `no_std` machine whose long-lived state
contains only guest-visible CPU and controller policy. The caller owns the
64 KiB RAM, 256-byte boot ROM, terminal queues, persistent sector media, and
optional video and sound transports. It lends those resources for one bounded
execution slice.

```text
caller-owned                         triptych-cpu-core
+-----------------------+            +-----------------------------+
| RAM + boot ROM        |--borrow--->| private Z80 adapter         |
| console + sectors     |--borrow--->| overlay + serial policy     |
| optional VDP + sound  |--borrow--->| disk cache + write staging  |
| optional I/O observer |<--events---| low-byte port router        |
+-----------------------+            +-----------------------------+
```

The selected shape combines a memory-stateless `Machine` with
capability-separated devices:

```rust
pub struct Machine { /* private CPU and controller state */ }

pub struct MachineMemory<'a> {
    /* borrowed [u8; 65_536] RAM and [u8; 256] ROM */
}

pub struct Devices<'a> {
    /* borrowed console, sectors, optional VDP/sound, and observer */
}

impl Machine {
    pub fn step(
        &mut self,
        memory: &mut MachineMemory<'_>,
        devices: &mut Devices<'_>,
        interrupt: InterruptRequest,
    ) -> StepResult;

    pub fn run_slice(
        &mut self,
        memory: &mut MachineMemory<'_>,
        devices: &mut Devices<'_>,
        budget: RunBudget,
    ) -> RunExit;
}
```

`Machine` never retains a memory or host-service reference. A native, WASM, or
ESP-IDF wrapper can therefore own its machine and buffers normally, choose the
buffers' physical placement, poll its platform between slices, and rebuild the
borrowed device bundle without self-referential or global state.

## Ownership and invariants

The core owns:

- the exact `cell80-z80 = "=0.8.0"` adapter and private CPU state;
- ROM-overlay state and all low-byte port decoding;
- a one-byte serial lookahead used to make status polling non-destructive;
- disk selection, errors, a 512-byte cache line, and a private 128-byte write
  staging buffer;
- exact instruction and interrupt T-state accounting.

The caller owns:

- RAM and ROM storage;
- console input and output queues;
- complete persistent 512-byte sectors and their durability mechanism;
- optional VDP and sound implementations;
- transcript storage, clocks, threads, files, browser objects, and ESP-IDF
  objects.

An incomplete 128-byte disk write changes neither cache nor media. The final
byte publishes the complete staged record to one cache quarter. Dirty cache
writeback must succeed before replacement; a failed flush leaves the cache
dirty and retryable. Reset aborts a partial transfer but neither clears RAM nor
flushes or discards an already-published dirty cache line.

The I/O observer receives every completed operation with the full 16-bit Z80
port address and resolved byte. Routing then uses the documented low byte. The
observer is an allocation-free no-op unless a host supplies one.

## Engine boundary

Only the private engine adapter imports `cell80-z80`. Public CPU snapshots,
flags, run results, errors, and interrupt requests are Triptych-owned types.
The dependency's disassembler and `ED FE` host-trap convention are not part of
the machine.

The current engine supplies a fixed `$FF` interrupt-acknowledge byte. The first
API therefore supports only `InterruptRequest::None` and
`InterruptRequest::MaskableFf`; it does not claim NMI or arbitrary IM0/IM2 data
until another proof justifies them.

## Alternatives rejected

- A `Machine<'a>` retaining RAM and ROM borrows makes native and WASM wrappers
  self-referential and prevents the owner from freely placing or replacing
  buffers.
- A monolithic host trait makes independently replaceable console, storage,
  VDP, and sound implementations appear to be one device.
- Core-owned `Vec` buffers, stored boxed callbacks, async traits, and platform
  synchronization introduce allocation or target policy into the portable
  machine.
- Moving the disk cache or 128-byte staging to the host would allow hosts to
  disagree about guest-visible atomic publication.
- Exposing third-party register types would turn an engine replacement into a
  public breaking change.

## First executable predicate

The first predicate is exact native reproduction of the reset, flags/timing,
overlay, serial-order, and `$FF` IM1 conformance fixtures while the core remains
`no_std`. The same crate must then link for `wasm32-unknown-unknown` and the
ESP32-S3 Xtensa target. A target build is a portability proof, not an ESP32
hardware measurement.
