# Z80 execution host surface v0

**Status:** implemented substrate contract; compiler adapters remain a later
qualification gate

**Scope:** Triptych's macOS-native and WebAssembly hosts

This document describes the small host-controlled execution surface shared by
the next Atom and Nucleus adapters. It is deliberately below CP/M and above
the private Z80 engine. ESP32 is not an acceptance target for this contract.

## Responsibilities

The Triptych CPU core owns instruction semantics, architectural registers,
memory reads and writes, low-byte port decoding, reset and cycle accounting.
The host owns image preparation, scheduling, service interpretation and any
presentation or persistent storage. The host must not reach into the engine's
private state.

The surface has four operations:

1. copy a flat image into the 64 KiB guest RAM;
2. select the entry point and any initial architectural fields before the first
   instruction;
3. execute one instruction and observe its cycle count and ordered I/O; and
4. apply a synchronous service result to memory or architectural fields before
   the next instruction.

This is an execution substrate, not an operating-system ABI. It does not
define BDOS, BIOS, CP/M files, terminals, compiler services or a transport.

## State boundary

The public `CpuState` fields are the only fields a host may initialise or
update. `Machine::install_execution_cpu_state` changes those fields without
resetting devices or RAM. The WASM host exposes the same operation as
`set_execution_cpu_field`; malformed values are rejected by the binding.

The reset-time boot overlay is part of the Triptych machine profile. A bare
execution image may call `disable_boot_rom_for_execution` before its first
instruction. A later machine reset restores the overlay. Disabling the
overlay after execution has started is rejected.

## Memory and I/O

The host may write image bytes through the checked RAM API before execution.
The WASM binding also exposes the address and length of the fixed 64 KiB
allocation so a higher-level adapter can create a zero-copy view of its linear
memory. The view is instance-owned and must not outlive its CPU object.

When I/O tracing is enabled, each completed instruction appends its ordered
port operations. The packed representation remains the existing Triptych
format: bits 0–7 contain the transferred byte, bits 8–23 contain the full Z80
port, and bit 24 identifies a write. A host service consumes the trace after
the instruction, applies any memory/register result, and then resumes the
guest. This makes a synchronous port service observable without putting a
JavaScript callback or filesystem operation inside the CPU core.

The full Z80 port is retained in the trace. A test program using `OUT (n),A`
therefore records the accumulator in the high byte, while the machine's
guest-visible device routing continues to use the documented low byte.

## Qualification predicate

The substrate is accepted for an adapter only when native and WASM runs agree
on all of the following for the same image and initial state:

- loaded RAM bytes and entry PC;
- register and flag updates applied between instructions;
- the ordered full-port I/O trace;
- serial output and final CPU state;
- instruction and T-state counts; and
- the distinction between a HALT and a run-budget stop.

The current executable proof loads a five-instruction image, emits one byte,
halts, checks the full port (`A << 8 | n`) and exercises register/flag setup.
It is a substrate proof, not yet a claim that Nucleus or Atom has been
qualified on the Rust host. Those adapters must add their own source,
diagnostic and artifact records.
