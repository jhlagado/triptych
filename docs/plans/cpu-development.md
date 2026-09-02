# Triptych CPU development plan

Status: active plan

Date: 2026-08-31

## Outcome

Build one deterministic Z80-compatible Triptych CPU machine that behaves the
same on:

- a native macOS or Linux command-line host;
- a browser through WebAssembly; and
- a Waveshare ESP32-S3 CPU module.

The CPU module is the only implementation target in this plan. Video and sound
retain their reserved guest port ranges and independent specifications, but no
VDP, audio, inter-module SPI, connector, or interrupt work is required to
complete the CPU milestones.

## Decisions already made

| Area             | Decision                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guest machine    | The normative v0.1 CPU profile remains the authority.                                                                                                         |
| Guest CPU        | An emulated Z80 is the intended machine; a physical 5 V Z80 is not an initial constraint.                                                                     |
| Initial machine  | Flat 64 KiB RAM, 256-byte boot overlay, serial console, SD-backed logical-record disks, polling only.                                                         |
| Production core  | Rust is the provisional primary language. Stage 2 uses exactly `cell80-z80` 0.8.0 behind a replaceable Triptych adapter; ESP32-S3 feasibility remains a gate. |
| C                | C is used for a small official ESP-IDF hardware baseline and remains the measured fallback. It is not a parallel CPU implementation.                          |
| Reference model  | The existing TypeScript implementation remains an executable semantic oracle during the port. It is not production firmware.                                  |
| First host       | Native macOS development, with Linux CI from the start.                                                                                                       |
| Second host      | Headless WebAssembly after native transcript parity.                                                                                                          |
| Hardware         | Waveshare `ESP32-S3-DEV-KIT-N16R8-M`, SKU 28836, with 16 MiB flash and 8 MiB PSRAM. Two boards have been ordered.                                             |
| Storage hardware | A separate 3.3 V microSD breakout connects over SPI on a solderless breadboard. Its exact presence in the order is to be confirmed when the package arrives.  |
| First console    | Power, flashing, and the initial 115200 8N1 console share one USB-C cable. Use the board's CH343 USB-to-UART port first; qualify native USB separately.       |
| Framework        | No Arduino framework. ESP-IDF is the hardware authority. PlatformIO may be an optional editor wrapper, but it is not the canonical build.                     |
| Portability      | Core code has no filesystem, terminal, browser, ESP-IDF, FreeRTOS, wall-clock, or Debug80 dependency.                                                         |
| Debugging        | The debugger is an out-of-band host control surface, not a new guest-visible port range.                                                                      |

## Selected architecture

The production machine has one core and several replaceable hosts:

```text
                         deterministic fixtures
                                  |
                    +-------------+-------------+
                    | TypeScript reference model|
                    +-------------+-------------+
                                  | compare state, I/O and cycles
                                  v
+-------------------------------------------------------------------+
| triptych-cpu-core (portable Rust, no_std-compatible)               |
| Z80 state and execution; 64 KiB machine; boot overlay; port decode |
| serial and disk-controller state; cycle accounting; reset          |
+----------------------+----------------------+----------------------+
                       |                      |
             host-owned services             | out-of-band inspection
        console bytes and 512-byte sectors    | step, stop, memory, registers
                       |                      |
          +------------+------------+---------+------------+
          |                         |                      |
  native macOS/Linux          browser/WASM          ESP32-S3/ESP-IDF
  terminal + disk image       JS adapters           USB serial + microSD
```

The core owns every fact the guest can observe: registers, flags, T-states,
memory, overlay state, low-byte port decoding, disk command state, byte order,
and reset behaviour. A host supplies console bytes, persistent 512-byte sector
operations, pacing, and presentation. A host must not modify core state behind
the core's API.

The first Rust interface should have this shape, although names may change
during the feasibility spike:

```rust
pub trait Console {
    fn receive(&mut self) -> Option<u8>;
    fn transmit(&mut self, byte: u8);
}

pub trait SectorStore {
    fn sector_count(&self, drive: u8) -> Result<u32, StorageError>;
    fn read_sector(
        &mut self,
        drive: u8,
        lba: u32,
        output: &mut [u8; 512],
    ) -> Result<(), StorageError>;
    fn write_sector(
        &mut self,
        drive: u8,
        lba: u32,
        input: &[u8; 512],
    ) -> Result<(), StorageError>;
    fn flush(&mut self, drive: u8) -> Result<(), StorageError>;
}

impl Machine {
    pub fn reset(&mut self);
    pub fn run(
        &mut self,
        services: &mut impl HostServices,
        tstate_budget: u64,
    ) -> RunExit;
}
```

The logical-record controller and its 128-byte publication rules stay inside
the core. The storage host sees only complete 512-byte sectors. The host paces
successive `run` calls; instruction execution never reads a wall clock.

## Planned repository shape

The paths below are created only when their first executable milestone begins:

```text
crates/
  triptych-cpu-core/       portable Rust machine, no_std-compatible
  triptych-host-native/    macOS/Linux terminal and disk-image executable
  triptych-host-wasm/      browser adapter, no UI policy in the core
firmware/cpu/              Rust-over-ESP-IDF CPU firmware and board config
tools/hardware-probes/
  esp32-s3-c/              development-only ESP-IDF C hardware baseline
test/conformance/          language-neutral fixtures and expected transcripts
docs/reports/              retained host proofs and physical measurements
```

The standard Rust toolchain builds the core, native host, and WASM host. The
ESP32 firmware remains a separate Cargo project because ESP32-S3 currently
requires the Espressif Xtensa Rust/LLVM toolchain. It depends on the portable
core by path but maintains target-specific configuration and a separately
pinned lockfile.

## Toolchain policy

### Portable development

- Pin stable Rust in `rust-toolchain.toml` when the Rust workspace is created.
- Run formatting, Clippy with warnings denied, unit tests, and native
  conformance tests on macOS and Linux.
- Build `wasm32-unknown-unknown` in CI. Browser bindings belong only to the WASM
  host crate.
- Use sanitizers or Miri on supported host code when they add useful coverage;
  neither substitutes for cross-host conformance.

### ESP32-S3 Rust

- Install and pin the Espressif Xtensa toolchain through `espup`.
- Use Rust with ESP-IDF initially so that SD, FAT, USB serial, FreeRTOS, and
  board diagnostics retain Espressif's mature C implementation.
- Pin the Rust toolchain, `esp-idf-sys` family, ESP-IDF release, Cargo lockfile,
  flash mode, flash size, and octal-PSRAM configuration.
- Build the firmware in CI before hardware arrives. A successful link is a
  toolchain proof, not a hardware proof.

### ESP32-S3 C baseline

- Use direct, pinned ESP-IDF and `idf.py`, not Arduino.
- Keep the probe small: identify the chip and reset cause, report flash and
  PSRAM, exercise USB serial, and test the chosen microSD wiring.
- Do not add guest CPU, memory, ports, BIOS, or emulator logic to the C probe.
- Reproduce the same hardware observations in Rust. This separates board or
  wiring defects from Rust binding and toolchain defects.

PlatformIO is optional. The canonical commands remain Cargo for Rust and
`idf.py` for the C probe, which keeps macOS and Linux builds visible and
scriptable without an additional project model.

## Conformance strategy

Every production host must consume the same language-neutral fixtures. A
fixture records enough information to reproduce and compare a run:

- initial registers, interrupt state, memory ranges, and port inputs;
- program and ROM bytes;
- requested instruction or T-state budget;
- expected registers, flags, PC, SP, interrupt state, and T-state count;
- hashes of defined memory ranges;
- the ordered port-read and port-write transcript;
- the stop reason, such as budget exhausted, HALT, breakpoint, or fault.

Comparison uses canonical bytes and integers rather than language-specific
serialization. The TypeScript reference, native Rust, WASM, and ESP32 firmware
must produce the same digest for deterministic fixtures. Hardware measurements
such as elapsed time, heap use, SD latency, or supply behaviour are recorded
separately and are never inferred from a host-model pass.

Any third-party Z80 test corpus, emulator source, ROM, or disk image requires a
recorded version, provenance, and compatible licence before it enters the
repository.

## Staged roadmap

Each stage has one exit predicate. Later stages do not compensate for an
unproved earlier boundary.

| Stage | Status on 2026-08-31    | Evidence                                                              |
| ----- | ----------------------- | --------------------------------------------------------------------- |
| 0     | complete                | repository check and retained CPU v0.1 proof                          |
| 1     | complete                | [conformance and engine report](../reports/cpu-stage1-conformance.md) |
| 2     | complete                | [CPU Alpha report](../reports/cpu-alpha.md)                           |
| 3     | machine and host proved | all fixtures and native fresh-process test; debugger controls remain  |
| 4     | complete                | two-process CP/M proof in the CPU Alpha report                        |
| 5     | complete                | [WASM host report](../reports/cpu-stage5-wasm.md)                     |
| 6     | complete                | [ESP-IDF build report](../reports/cpu-stage6-espidf-build.md)         |

### Stage 0 — preserve the current baseline

Work:

- keep the CPU v0.1 profile authoritative;
- retain the TypeScript machine and CP/M 2.2 compatibility proof;
- classify board, pin, task, and toolchain choices as experimental;
- keep VDP and sound implementation out of the CPU schedule.

Exit: `npm run check` passes, and the optional CP/M proof's external image and
licence requirements remain documented.

### Stage 1 — create the conformance corpus

Work:

- define the fixture format and canonical transcript digest;
- export current overlay, serial, disk, port-routing, reset, and cold-boot
  cases from the TypeScript tests;
- add focused Z80 instruction, flag, HALT, interrupt, and T-state cases;
- evaluate a maintained Rust Z80 engine against correctness, `no_std`
  compatibility, timing information, licence, and dependency weight.

Exit: the TypeScript reference can run every fixture and reproduce the checked
expected result; the Rust Z80 reuse-or-implement decision is recorded.

### Stage 2 — prove the Rust core shape

Work:

- create `triptych-cpu-core` without `std`, filesystem, clock, threads, or ESP
  dependencies;
- implement reset, deterministic run budgeting, memory access, and the boot
  overlay around the selected Z80 engine;
- compile the same crate for native, WASM, and ESP32-S3 targets;
- prove that a host owns buffers and services without shared mutable machine
  state or hidden global allocation.

Exit: the minimal core passes its conformance slice natively and compiles for
both `wasm32-unknown-unknown` and ESP32-S3. Failure at this stage triggers a
written Rust-versus-C review before more production code is added.

### Stage 3 — complete the native CPU machine

Work:

- port serial, disk-controller, low-byte port routing, and reset semantics;
- add a native terminal and file-backed disk-image host;
- add out-of-band single-step, register, memory, breakpoint, and trace controls;
- keep debugger operations between run slices so only one owner mutates the
  machine.

Exit: all CPU v0.1 host-model fixtures match TypeScript, including ordered I/O,
memory hashes, error rejection, and cycle counts.

### Stage 4 — reproduce the operating-system proof

Work:

- assemble the existing bootstrap and BIOS reproducibly;
- cold-boot the existing CP/M 2.2 compatibility image;
- run a `.COM` program, write and flush a file, recreate the host, and read it
  after a second cold boot;
- then begin the separately provenance-recorded CP/Mish machine port.

Exit: the native Rust run produces the same guest-visible transcript and
persistent-file result as the retained TypeScript proof. CP/Mish is a later
substage and does not redefine the machine to make its port easier.

### Stage 5 — add the headless WASM host

Work:

- expose run, reset, console, disk-image, and inspection adapters to JavaScript;
- run in bounded T-state slices so the browser event loop remains responsive;
- keep DOM, rendering, and browser storage policy out of the core;
- defer a polished UI until transcript parity is established.

Exit: automated browser tests produce the same conformance digests and CP/M
serial transcript as the native host.

### Stage 6 — establish the ESP32 build before arrival

Work:

- scaffold the standalone Rust-over-ESP-IDF firmware project;
- select ESP32-S3, 16 MiB quad flash, and 8 MiB octal PSRAM configuration;
- link the portable core and a serial-only deterministic self-test;
- retain binary size, section sizes, and linker memory report in a host-build
  report clearly labelled as unmeasured on hardware.

Exit: a clean macOS build and a clean Linux build produce flashable images from
pinned inputs. No claim about booting, PSRAM, SD, or timing is made yet.

### Stage 7 — perform physical board bring-up

Work, when the boards arrive:

1. Record photographs or markings, Waveshare SKU, WROOM module suffix, and the
   contents of the order.
2. Mount the development board across two breadboards or their join so useful
   holes remain exposed.
3. Power the ESP32 only through a known-good USB-C data cable during bring-up.
4. Select the CH343 USB-to-UART device in CoolTerm or another serial terminal
   at 115200 8N1 and retain the boot log produced by reset.
5. Run the C ESP-IDF baseline and record chip revision, flash, PSRAM, internal
   RAM, USB serial ports, reset behaviour, and idle stability.
6. Run the equivalent Rust image and compare the observations.

Exit: both probes boot repeatedly and agree on 16 MiB flash and 8 MiB PSRAM;
any discrepancy is explained before storage or emulator work continues.

### Stage 8 — qualify breadboard microSD

Work:

- power the breakout from 3.3 V and share ground; never apply 5 V to an ESP32
  GPIO;
- choose GPIOs only after auditing PSRAM, native USB, strapping pins, and
  onboard devices;
- record the final experimental wiring and use short leads;
- begin at a conservative SPI clock;
- test identification, full-sector reads and writes, flush, reboot,
  card removal, out-of-range access, and repeated checksums.

Exit: the C and Rust probes pass the same destructive scratch-card test, and
the Rust CPU host passes the v0.1 write/flush/restart proof on physical media.
The card used for this test must contain no valuable data.

### Stage 9 — run and measure the complete CPU unit

Work:

- keep the 64 KiB guest RAM and hot emulator state in internal RAM initially;
- place large trace, snapshot, and cache buffers in PSRAM only after checking
  their actual addresses and effect on execution;
- implement 4 MHz nominal pacing outside instruction semantics;
- let one FreeRTOS task own the complete machine state; other tasks or drivers
  communicate through bounded queues and never mutate it directly;
- measure unpaced and 4 MHz execution, storage latency, serial loss, memory
  high-water marks, queue overflow, resets, and error recovery.

Exit: a one-hour CPU-only run repeatedly boots, exercises the monitor, reads
and writes the SD image, flushes, resets, and validates persisted data without
an unexplained crash, corrupt record, lost console byte, or conformance digest
change.

### Stage 10 — freeze the first production direction

Rust becomes the production CPU implementation only after Stages 2 through 9
pass. If it fails, the decision report must name a concrete failure—unsupported
target feature, unacceptable toolchain reproducibility, missing peripheral
access, memory overhead, performance margin, or debugging limitation—and show
why it cannot be isolated in the host adapter.

Only then may a C core be considered. A C fallback must consume the same
fixtures and preserve the same host boundary; it is not permission to fork the
machine contract. A C ABI around the Rust core is added only when an actual
consumer requires it.

Exit: `docs/reports/` contains the decision, toolchain versions, conformance
results, hardware measurements, remaining risks, and the exact next milestone.

## Hardware bring-up rules

- Treat all breadboard GPIO choices as experimental until Stage 8 passes.
- The N16R8 module's octal PSRAM makes GPIO35, GPIO36, and GPIO37 unavailable.
- Reserve GPIO19 and GPIO20 while native USB is in use.
- Avoid boot-strapping pins for the first SD experiment unless their electrical
  levels and boot behaviour are explicitly verified.
- Use pre-soldered headers and jumper wires; the first CPU prototype requires
  no surface-mount work or custom PCB.
- Keep SD wiring short. If errors occur, lower the SPI clock and improve the
  wiring before changing filesystem or emulator code.
- Record pin assignments beside the measurement that qualified them. Do not
  copy an experimental pin map into the guest specification.

## Deferred decisions

These remain open until the stage that can measure them:

- replacement of `cell80-z80` 0.8.0 if a Stage 2 gate fails;
- microSD GPIOs, SPI controller, clock, and filesystem layout;
- internal-RAM versus PSRAM placement beyond the initial conservative plan;
- FreeRTOS task priority and core affinity;
- native USB versus USB-to-UART as the finished console;
- CP/Mish image construction and distributable component provenance;
- a graphical native or browser debugger;
- banked RAM and any firmware-service ABI.

VDP, sound, shared module transport, interrupt policy, and connectors are
outside this plan. Their reserved ports remain inert when those modules are
absent.

## Immediate next work

The native macOS workflow now has a persistent CP/M working-disk utility. Its
retained proof imports pinned Atom and source files, assembles inside the guest,
reopens the disk in another native-host process, and runs the generated COM.
The next native-first slice should repeat that boundary with the separately
provenanced Nucleus compiler and a small Nucleus source, then compare the
exported output with its existing host proof. Out-of-band native debugger
controls remain a separate Stage 3 convenience and must not change the guest
machine.

When the boards arrive, Stage 7 still starts independently with the CH343 reset
log and direct ESP-IDF C hardware probe. Nothing in the native working-disk
proof is ESP32 hardware evidence.

## References

- [CPU v0.1 machine profile](../specifications/cpu-v0.1.md)
- [Current CPU proof report](../reports/cpu-v0.1-proof.md)
- [Stage 1 conformance and Z80-engine decision](../reports/cpu-stage1-conformance.md)
- [Waveshare ESP32-S3 development-board documentation](https://docs.waveshare.com/ESP32-S3-DEV-KIT-N8R8)
- [Espressif ESP32-S3 DevKitC-1 hardware reference](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/)
- [ESP-IDF ESP32-S3 programming guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/)
- [Rust on ESP toolchain installation](https://docs.espressif.com/projects/rust/book/getting-started/toolchain.html)
- [Rust-over-ESP-IDF template](https://github.com/esp-rs/esp-idf-template)
