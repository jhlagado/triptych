# CPU Stage 1 conformance and Z80-engine decision

Status: host-model proof complete

Date: 2026-08-31

## Decision

Triptych will reuse [`cell80-z80` 0.8.0](https://crates.io/crates/cell80-z80/0.8.0)
behind a Triptych-owned adapter for the Stage 2 Rust core. The Cargo dependency
must initially be pinned exactly as `cell80-z80 = "=0.8.0"`.

This is a provisional implementation choice, not a programmer-visible machine
contract. `triptych-cpu-core` owns reset policy, memory and overlay behaviour,
port decoding, deterministic budgets, serial and disk state, and the public
inspection API. No `cell80-z80` type crosses that crate's public boundary. This
keeps replacement possible if the Xtensa or Triptych conformance gates expose a
defect.

Triptych will not implement another Z80 execution engine now. The selected
crate has a small enough integration surface and substantially stronger
evidence than a new implementation could acquire during the next milestone.

## Stage 1 corpus

The language-neutral contract is
[`cpu-conformance-v1.md`](../specifications/cpu-conformance-v1.md). Six JSON
fixtures now retain complete expected results and canonical SHA-256 transcripts:

| Fixture                      | Discriminator                                                                |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `reset-defined-state`        | defined reset PC, IM, IFF and HALT state                                     |
| `flags-conditional-timing`   | primary flags, taken/not-taken branches and exact T-states                   |
| `interrupt-im1`              | EI delay, IM 1 entry, pushed return address and interrupt timing             |
| `serial-read-order`          | ordered reads, input consumption and complete 16-bit port addresses          |
| `boot-overlay-serial`        | ROM reads, underlying RAM writes, serial output and keyed overlay removal    |
| `cold-boot-disk-persistence` | block-free cold load, overlay handoff, record write, explicit flush and HALT |

The cold-boot fixture deliberately avoids Z80 block-repeat instructions so
instruction-step counts have one meaning across debugger and production APIs.
Its two retained assembly inputs live beside the fixtures under
`test/conformance/programs/`; the fixture itself contains their assembled bytes
and requires no assembler at test time.

`npm run test:cpu-conformance` reproduced all six expected results and digests
with the TypeScript reference model. The complete `npm run check` gate passed
all 45 repository tests. Debug80 Runtime appears only in the TypeScript test
adapter; no production source imports it.

This is host-model evidence. It says nothing about ESP32 execution speed,
memory placement, USB, PSRAM, SD wiring, or physical reliability.

## Engine evaluation

The evaluation used the upstream sources current on 2026-08-31 and a temporary
Rust 1.98.0 toolchain. Temporary checkouts and toolchains were outside the
Triptych repository.

| Candidate                 | Result                   | Evidence and reason                                                                                                                                                                                                           |
| ------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cell80-z80` 0.8.0        | select                   | MIT/Apache-2.0; no Cargo dependencies; explicit `Bus`; exposed CPU state; exact T-state reporting; `no_std`; strongest locally reproduced test battery                                                                        |
| `z80emu` 0.11.0           | keep as fallback/control | mature cycle-level `Clock`/`Memory`/`Io` traits and richer interrupt modelling; `no_std`; three small dependencies; LGPL-3.0-or-later; upstream last changed in 2024 and no comparable external corpus was reproduced locally |
| `iz80` 0.5.1              | reject                   | BSD-3-Clause and active, but requires `std` and heap-built decoder tables; the source panics for IM 0 and IM 2; its bare-metal build failed                                                                                   |
| `ez80`, `rz80`, C engines | reject for Stage 2       | either unnecessary eZ80/peripheral scope, weaker maintenance evidence, a less suitable host boundary, or a second language boundary without compensating proof                                                                |

Primary upstream evidence:

- [`cell80-z80` documentation](https://docs.rs/cell80-z80/0.8.0/z80/) and
  [source repository](https://github.com/chrishayuk/cell80/tree/main/z80)
- [`cell80-z80` correctness harness](https://github.com/chrishayuk/cell80/tree/main/z80-tests)
- [`z80emu` documentation](https://docs.rs/z80emu/0.11.0/z80emu/) and
  [source repository](https://github.com/royaltm/rust-z80emu)
- [`iz80` source repository](https://github.com/ivanizag/iz80)

## Reproduced candidate proofs

The published `cell80-z80 = "=0.8.0"` crate was used by a minimal `#![no_std]`
probe and passed `cargo check` for:

- `aarch64-apple-darwin`;
- `wasm32-unknown-unknown`; and
- `thumbv7em-none-eabihf`.

`cargo tree` showed only the probe and `cell80-z80`; the selected crate has no
runtime Cargo dependencies. The published crate's seven source files were
byte-identical to the evaluated upstream checkout at commit `f7ff045`. The
following also passed locally:

- 86,000 of 86,000 SingleStepTests cases across the repository's 86-file
  representative instruction subset, including final state and cycle counts;
- the complete ZEXDOC exerciser, with every reported instruction group `OK`;
- 57 ordinary unit, interrupt, decode, disassembly and harness tests.

Upstream reports 1,530,000 of 1,530,000 cases for the complete SingleStepTests
download. That larger result was not independently rerun here and is not being
presented as a Triptych measurement. ZEXALL was likewise not rerun.

For comparison, `z80emu` 0.11.0 passed native, WASM and bare-target
`--no-default-features` checks plus 39 library tests. `iz80` passed native and
WASM checks but failed the bare target because it requires `std`.

## Known risks and Stage 2 gates

The selection remains reversible for specific reasons:

- `cell80-z80` is young and has a small user community.
- Its maskable-interrupt API fixes the acknowledge byte at `$FF`; this is
  sufficient for the current IM 1 fixture and v0.1 polling machine, but not a
  general Triptych IM 0/IM 2 device-vector contract.
- The crate exposes an optional `ED FE` host trap. Triptych will not make this a
  guest ABI in Stage 2.
- The crate's disassembler uses `alloc`, although the CPU execution path does
  not. A library `cargo check` does not by itself prove the final core links
  without a global allocator.
- No ESP32-S3 Xtensa build has yet been performed.

Stage 2 must therefore:

1. wrap the engine without exposing its types or host-trap convention;
2. reproduce all six Triptych fixture results natively, including exact
   T-states, full port addresses, drive hashes and the 817-step cold boot;
3. link the minimal core for native, `wasm32-unknown-unknown`, and ESP32-S3,
   rather than stopping at a library check;
4. prove that execution performs no hidden allocation and that host-owned
   buffers remain the only large storage;
5. record binary size and any adapter work required for interrupt acknowledge
   data or NMI before those features become part of a later machine profile.

Failure of one of these gates triggers the planned written comparison with
`z80emu` and then C; it does not authorize changing the v0.1 machine contract to
fit the selected crate.
