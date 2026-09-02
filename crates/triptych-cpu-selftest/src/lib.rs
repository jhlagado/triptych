#![no_std]

//! Allocation-free execution of Triptych's checked CPU conformance fixtures.
//!
//! JSON parsing and fixture validation happen in the repository generator. The
//! generated constants and this runner are the host-test boundary shared by the
//! native checks and the ESP32-S3 serial self-test.

use core::fmt::{self, Write};

use sha2::{Digest, Sha256};
use triptych_cpu_core::{
    Console, CpuState, Devices, DriveInfo, InterruptRequest, IoDirection, IoObserver, IoOperation,
    Machine, MachineMemory, SectorStore, StorageFault, BOOT_ROM_BYTES, RAM_BYTES, SECTOR_BYTES,
};

mod generated;

const MAX_SERIAL_INPUT: usize = 1;
const MAX_SERIAL_OUTPUT: usize = 2;
const MAX_IO_OPERATIONS: usize = 272;

pub const FIXTURE_COUNT: usize = generated::FIXTURES.len();

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FixturePass {
    pub fixture: &'static str,
    pub source_sha256: [u8; 32],
    pub result_sha256: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FixtureFailure {
    pub fixture: &'static str,
    pub kind: FailureKind,
    pub detail: &'static str,
    pub index: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FixtureEvent {
    Passed(FixturePass),
    Failed(FixtureFailure),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SuiteSummary {
    pub passed: usize,
    pub failed: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureKind {
    Stop,
    Steps,
    TStates,
    Cpu,
    BootOverlay,
    RamHash,
    RamRange,
    DriveHash,
    Serial,
    Io,
    BufferOverflow,
    CanonicalDigest,
}

impl FailureKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Stop => "stop",
            Self::Steps => "steps",
            Self::TStates => "tstates",
            Self::Cpu => "cpu",
            Self::BootOverlay => "boot-overlay",
            Self::RamHash => "ram-hash",
            Self::RamRange => "ram-range",
            Self::DriveHash => "drive-hash",
            Self::Serial => "serial",
            Self::Io => "io",
            Self::BufferOverflow => "buffer-overflow",
            Self::CanonicalDigest => "canonical-digest",
        }
    }
}

pub fn run_all(ram: &mut [u8; RAM_BYTES], mut report: impl FnMut(FixtureEvent)) -> SuiteSummary {
    let mut summary = SuiteSummary {
        passed: 0,
        failed: 0,
    };
    for fixture in generated::FIXTURES {
        match run_fixture(fixture, ram) {
            Ok(pass) => {
                summary.passed += 1;
                report(FixtureEvent::Passed(pass));
            }
            Err(failure) => {
                summary.failed += 1;
                report(FixtureEvent::Failed(failure));
            }
        }
    }
    summary
}

fn run_fixture(
    fixture: &'static Fixture,
    ram: &mut [u8; RAM_BYTES],
) -> Result<FixturePass, FixtureFailure> {
    fixture.ram.materialize(ram);
    let mut boot_rom = [0; BOOT_ROM_BYTES];
    fixture.boot_rom.materialize(&mut boot_rom);

    let mut host = FixtureHost::new(fixture);
    let mut machine = Machine::new();
    let mut initial_cpu = CpuState::default();
    for patch in fixture.initial_cpu {
        patch.field.set(&mut initial_cpu, patch.value);
    }
    machine.install_conformance_cpu_state(initial_cpu);
    {
        let mut devices =
            Devices::new(&mut host.console, &mut host.store).with_observer(&mut host.observer);
        machine.reset(&mut devices);
    }
    host.console.load_input(fixture.serial_input);

    let (stop, steps, tstates) = {
        let mut memory = MachineMemory::new(ram, &boot_rom);
        let mut devices =
            Devices::new(&mut host.console, &mut host.store).with_observer(&mut host.observer);
        run_steps(fixture, &mut machine, &mut memory, &mut devices)
    };

    if host.console.overflow || host.observer.overflow {
        return Err(failure(
            fixture,
            FailureKind::BufferOverflow,
            if host.console.overflow {
                "serial"
            } else {
                "io"
            },
            0,
        ));
    }

    let state = machine.cpu_state();
    let ram_sha256 = sha256(ram);
    let drive_sha256 = host.store.digest();

    compare_complete_result(
        fixture,
        stop,
        steps,
        tstates,
        &state,
        machine.boot_rom_enabled(),
        ram,
        ram_sha256,
        drive_sha256,
        host.console.output(),
        host.observer.operations(),
    )?;

    let digest = canonical_digest(
        fixture,
        stop,
        steps,
        tstates,
        &state,
        machine.boot_rom_enabled(),
        ram,
        ram_sha256,
        drive_sha256,
        host.console.output(),
        host.observer.operations(),
    );
    if digest != fixture.expected.digest {
        return Err(failure(fixture, FailureKind::CanonicalDigest, "sha256", 0));
    }

    Ok(FixturePass {
        fixture: fixture.id,
        source_sha256: fixture.source_sha256,
        result_sha256: digest,
    })
}

fn run_steps(
    fixture: &Fixture,
    machine: &mut Machine,
    memory: &mut MachineMemory<'_>,
    devices: &mut Devices<'_>,
) -> (Stop, u64, u64) {
    let mut steps = 0;
    let mut tstates = 0;
    while steps < fixture.max_steps {
        let next_step = steps + 1;
        let interrupt = if fixture.interrupts_after_step.contains(&next_step) {
            InterruptRequest::MaskableFf
        } else {
            InterruptRequest::None
        };
        let result = machine.step(memory, devices, interrupt);
        steps += 1;
        tstates += u64::from(result.tstates);
        if result.halted {
            return (Stop::Halt, steps, tstates);
        }
        if tstates >= fixture.max_tstates {
            return (Stop::TStateLimit, steps, tstates);
        }
    }
    (Stop::StepLimit, steps, tstates)
}

#[allow(clippy::too_many_arguments)]
fn compare_complete_result(
    fixture: &'static Fixture,
    stop: Stop,
    steps: u64,
    tstates: u64,
    state: &CpuState,
    boot_rom_enabled: bool,
    ram: &[u8; RAM_BYTES],
    ram_sha256: [u8; 32],
    drive_sha256: Option<[u8; 32]>,
    serial: &[u8],
    io: &[IoOperation],
) -> Result<(), FixtureFailure> {
    let expected = &fixture.expected;
    if stop != expected.stop {
        return Err(failure(fixture, FailureKind::Stop, "reason", 0));
    }
    if steps != expected.steps {
        return Err(failure(fixture, FailureKind::Steps, "count", 0));
    }
    if tstates != expected.tstates {
        return Err(failure(fixture, FailureKind::TStates, "count", 0));
    }
    for (index, item) in expected.cpu.iter().enumerate() {
        if item.field.value(state) != item.value {
            return Err(failure(
                fixture,
                FailureKind::Cpu,
                item.field.as_str(),
                index,
            ));
        }
    }
    if boot_rom_enabled != expected.boot_rom_enabled {
        return Err(failure(fixture, FailureKind::BootOverlay, "enabled", 0));
    }
    if ram_sha256 != expected.ram_sha256 {
        return Err(failure(fixture, FailureKind::RamHash, "sha256", 0));
    }
    for (index, item) in expected.ram.iter().enumerate() {
        let end = item.address + item.bytes.len();
        if ram[item.address..end] != *item.bytes {
            return Err(failure(fixture, FailureKind::RamRange, "bytes", index));
        }
    }
    match (drive_sha256, expected.drive_sha256) {
        (None, []) => {}
        (Some(actual), [wanted]) if actual == *wanted => {}
        _ => return Err(failure(fixture, FailureKind::DriveHash, "sha256", 0)),
    }
    if serial != expected.serial_output {
        let index = first_difference(serial, expected.serial_output);
        return Err(failure(fixture, FailureKind::Serial, "bytes", index));
    }
    if io != expected.io {
        let index = first_difference(io, expected.io);
        return Err(failure(fixture, FailureKind::Io, "operation", index));
    }
    Ok(())
}

fn first_difference<T: Eq>(actual: &[T], expected: &[T]) -> usize {
    actual
        .iter()
        .zip(expected)
        .position(|(left, right)| left != right)
        .unwrap_or(actual.len().min(expected.len()))
}

#[allow(clippy::too_many_arguments)]
fn canonical_digest(
    fixture: &Fixture,
    stop: Stop,
    steps: u64,
    tstates: u64,
    state: &CpuState,
    boot_rom_enabled: bool,
    ram: &[u8; RAM_BYTES],
    ram_sha256: [u8; 32],
    drive_sha256: Option<[u8; 32]>,
    serial: &[u8],
    io: &[IoOperation],
) -> [u8; 32] {
    let mut writer = DigestWriter(Sha256::new());
    writeln!(writer, "triptych-cpu-result-v1").expect("digest writer cannot fail");
    writeln!(writer, "fixture={}", fixture.id).expect("digest writer cannot fail");
    writeln!(writer, "stop={}", stop.as_str()).expect("digest writer cannot fail");
    writeln!(writer, "steps={steps}").expect("digest writer cannot fail");
    writeln!(writer, "tstates={tstates}").expect("digest writer cannot fail");
    writeln!(writer, "boot-rom-enabled={}", u8::from(boot_rom_enabled))
        .expect("digest writer cannot fail");
    for field in fixture.observe_cpu {
        writeln!(writer, "cpu.{}={}", field.as_str(), field.value(state))
            .expect("digest writer cannot fail");
    }
    writer
        .write_str("ram-sha256=")
        .expect("digest writer cannot fail");
    write_hex(&mut writer, &ram_sha256);
    writer.write_char('\n').expect("digest writer cannot fail");
    for range in fixture.observe_ram {
        write!(writer, "ram.{:04x}=", range.address).expect("digest writer cannot fail");
        write_hex(
            &mut writer,
            &ram[range.address..range.address + range.length],
        );
        writer.write_char('\n').expect("digest writer cannot fail");
    }
    writeln!(writer, "drives={}", usize::from(drive_sha256.is_some()))
        .expect("digest writer cannot fail");
    if let Some(digest) = drive_sha256 {
        writer
            .write_str("drive.0-sha256=")
            .expect("digest writer cannot fail");
        write_hex(&mut writer, &digest);
        writer.write_char('\n').expect("digest writer cannot fail");
    }
    writer
        .write_str("serial=")
        .expect("digest writer cannot fail");
    write_hex(&mut writer, serial);
    writer.write_char('\n').expect("digest writer cannot fail");
    for (index, operation) in io.iter().enumerate() {
        writeln!(
            writer,
            "io.{index}={},{:04x},{:02x}",
            match operation.direction {
                IoDirection::Read => 'r',
                IoDirection::Write => 'w',
            },
            operation.port,
            operation.value
        )
        .expect("digest writer cannot fail");
    }
    writer.0.finalize().into()
}

fn write_hex(writer: &mut DigestWriter, bytes: &[u8]) {
    for byte in bytes {
        write!(writer, "{byte:02x}").expect("digest writer cannot fail");
    }
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

fn failure(
    fixture: &'static Fixture,
    kind: FailureKind,
    detail: &'static str,
    index: usize,
) -> FixtureFailure {
    FixtureFailure {
        fixture: fixture.id,
        kind,
        detail,
        index,
    }
}

struct DigestWriter(Sha256);

impl fmt::Write for DigestWriter {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        self.0.update(value.as_bytes());
        Ok(())
    }
}

#[derive(Clone, Copy)]
struct BytePatch {
    address: usize,
    bytes: &'static [u8],
}

#[derive(Clone, Copy)]
struct ByteImage {
    size: usize,
    fill: u8,
    patches: &'static [BytePatch],
}

impl ByteImage {
    fn materialize(self, output: &mut [u8]) {
        debug_assert_eq!(output.len(), self.size);
        output.fill(self.fill);
        for patch in self.patches {
            output[patch.address..patch.address + patch.bytes.len()].copy_from_slice(patch.bytes);
        }
    }
}

#[derive(Clone, Copy)]
struct CpuPatch {
    field: CpuField,
    value: u32,
}

#[derive(Clone, Copy)]
struct CpuExpectation {
    field: CpuField,
    value: u32,
}

#[derive(Clone, Copy)]
struct RamRange {
    address: usize,
    length: usize,
}

#[derive(Clone, Copy)]
struct RamExpectation {
    address: usize,
    bytes: &'static [u8],
}

#[derive(Clone, Copy)]
struct Fixture {
    id: &'static str,
    source_sha256: [u8; 32],
    boot_rom: ByteImage,
    ram: ByteImage,
    drive: Option<ByteImage>,
    serial_input: &'static [u8],
    initial_cpu: &'static [CpuPatch],
    max_steps: u64,
    max_tstates: u64,
    interrupts_after_step: &'static [u64],
    observe_cpu: &'static [CpuField],
    observe_ram: &'static [RamRange],
    expected: ExpectedResult,
}

#[derive(Clone, Copy)]
struct ExpectedResult {
    stop: Stop,
    steps: u64,
    tstates: u64,
    cpu: &'static [CpuExpectation],
    boot_rom_enabled: bool,
    ram_sha256: [u8; 32],
    ram: &'static [RamExpectation],
    drive_sha256: &'static [[u8; 32]],
    serial_output: &'static [u8],
    io: &'static [IoOperation],
    digest: [u8; 32],
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Stop {
    Halt,
    StepLimit,
    TStateLimit,
}

impl Stop {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Halt => "halt",
            Self::StepLimit => "step-limit",
            Self::TStateLimit => "tstate-limit",
        }
    }
}

#[derive(Clone, Copy)]
#[allow(dead_code)] // The generated format supports the complete v1 CPU-field vocabulary.
enum CpuField {
    A,
    APrime,
    B,
    BPrime,
    C,
    CPrime,
    D,
    DPrime,
    E,
    EPrime,
    H,
    HPrime,
    L,
    LPrime,
    Ix,
    Iy,
    I,
    R,
    Sp,
    Pc,
    Imode,
    Iff1,
    Iff2,
    Halted,
    FS,
    FZ,
    FY,
    FH,
    FX,
    FP,
    FN,
    FC,
    FPrimeS,
    FPrimeZ,
    FPrimeY,
    FPrimeH,
    FPrimeX,
    FPrimeP,
    FPrimeN,
    FPrimeC,
}

impl CpuField {
    #[allow(clippy::too_many_lines)]
    const fn as_str(self) -> &'static str {
        match self {
            Self::A => "a",
            Self::APrime => "a_prime",
            Self::B => "b",
            Self::BPrime => "b_prime",
            Self::C => "c",
            Self::CPrime => "c_prime",
            Self::D => "d",
            Self::DPrime => "d_prime",
            Self::E => "e",
            Self::EPrime => "e_prime",
            Self::H => "h",
            Self::HPrime => "h_prime",
            Self::L => "l",
            Self::LPrime => "l_prime",
            Self::Ix => "ix",
            Self::Iy => "iy",
            Self::I => "i",
            Self::R => "r",
            Self::Sp => "sp",
            Self::Pc => "pc",
            Self::Imode => "imode",
            Self::Iff1 => "iff1",
            Self::Iff2 => "iff2",
            Self::Halted => "halted",
            Self::FS => "f.s",
            Self::FZ => "f.z",
            Self::FY => "f.y",
            Self::FH => "f.h",
            Self::FX => "f.x",
            Self::FP => "f.p",
            Self::FN => "f.n",
            Self::FC => "f.c",
            Self::FPrimeS => "f_prime.s",
            Self::FPrimeZ => "f_prime.z",
            Self::FPrimeY => "f_prime.y",
            Self::FPrimeH => "f_prime.h",
            Self::FPrimeX => "f_prime.x",
            Self::FPrimeP => "f_prime.p",
            Self::FPrimeN => "f_prime.n",
            Self::FPrimeC => "f_prime.c",
        }
    }

    fn value(self, state: &CpuState) -> u32 {
        match self {
            Self::A => u32::from(state.a),
            Self::APrime => u32::from(state.a_prime),
            Self::B => u32::from(state.b),
            Self::BPrime => u32::from(state.b_prime),
            Self::C => u32::from(state.c),
            Self::CPrime => u32::from(state.c_prime),
            Self::D => u32::from(state.d),
            Self::DPrime => u32::from(state.d_prime),
            Self::E => u32::from(state.e),
            Self::EPrime => u32::from(state.e_prime),
            Self::H => u32::from(state.h),
            Self::HPrime => u32::from(state.h_prime),
            Self::L => u32::from(state.l),
            Self::LPrime => u32::from(state.l_prime),
            Self::Ix => u32::from(state.ix),
            Self::Iy => u32::from(state.iy),
            Self::I => u32::from(state.i),
            Self::R => u32::from(state.r),
            Self::Sp => u32::from(state.sp),
            Self::Pc => u32::from(state.pc),
            Self::Imode => u32::from(state.imode),
            Self::Iff1 => u32::from(state.iff1),
            Self::Iff2 => u32::from(state.iff2),
            Self::Halted => u32::from(state.halted),
            Self::FS => u32::from(state.f.s),
            Self::FZ => u32::from(state.f.z),
            Self::FY => u32::from(state.f.y),
            Self::FH => u32::from(state.f.h),
            Self::FX => u32::from(state.f.x),
            Self::FP => u32::from(state.f.p),
            Self::FN => u32::from(state.f.n),
            Self::FC => u32::from(state.f.c),
            Self::FPrimeS => u32::from(state.f_prime.s),
            Self::FPrimeZ => u32::from(state.f_prime.z),
            Self::FPrimeY => u32::from(state.f_prime.y),
            Self::FPrimeH => u32::from(state.f_prime.h),
            Self::FPrimeX => u32::from(state.f_prime.x),
            Self::FPrimeP => u32::from(state.f_prime.p),
            Self::FPrimeN => u32::from(state.f_prime.n),
            Self::FPrimeC => u32::from(state.f_prime.c),
        }
    }

    #[allow(clippy::cast_possible_truncation)]
    fn set(self, state: &mut CpuState, value: u32) {
        match self {
            Self::A => state.a = value as u8,
            Self::APrime => state.a_prime = value as u8,
            Self::B => state.b = value as u8,
            Self::BPrime => state.b_prime = value as u8,
            Self::C => state.c = value as u8,
            Self::CPrime => state.c_prime = value as u8,
            Self::D => state.d = value as u8,
            Self::DPrime => state.d_prime = value as u8,
            Self::E => state.e = value as u8,
            Self::EPrime => state.e_prime = value as u8,
            Self::H => state.h = value as u8,
            Self::HPrime => state.h_prime = value as u8,
            Self::L => state.l = value as u8,
            Self::LPrime => state.l_prime = value as u8,
            Self::Ix => state.ix = value as u16,
            Self::Iy => state.iy = value as u16,
            Self::I => state.i = value as u8,
            Self::R => state.r = value as u8,
            Self::Sp => state.sp = value as u16,
            Self::Pc => state.pc = value as u16,
            Self::Imode => state.imode = value as u8,
            Self::Iff1 => state.iff1 = value != 0,
            Self::Iff2 => state.iff2 = value != 0,
            Self::Halted => state.halted = value != 0,
            Self::FS => state.f.s = value != 0,
            Self::FZ => state.f.z = value != 0,
            Self::FY => state.f.y = value != 0,
            Self::FH => state.f.h = value != 0,
            Self::FX => state.f.x = value != 0,
            Self::FP => state.f.p = value != 0,
            Self::FN => state.f.n = value != 0,
            Self::FC => state.f.c = value != 0,
            Self::FPrimeS => state.f_prime.s = value != 0,
            Self::FPrimeZ => state.f_prime.z = value != 0,
            Self::FPrimeY => state.f_prime.y = value != 0,
            Self::FPrimeH => state.f_prime.h = value != 0,
            Self::FPrimeX => state.f_prime.x = value != 0,
            Self::FPrimeP => state.f_prime.p = value != 0,
            Self::FPrimeN => state.f_prime.n = value != 0,
            Self::FPrimeC => state.f_prime.c = value != 0,
        }
    }
}

struct FixedConsole {
    input: [u8; MAX_SERIAL_INPUT],
    input_len: usize,
    input_position: usize,
    output: [u8; MAX_SERIAL_OUTPUT],
    output_len: usize,
    overflow: bool,
}

impl FixedConsole {
    const fn new() -> Self {
        Self {
            input: [0; MAX_SERIAL_INPUT],
            input_len: 0,
            input_position: 0,
            output: [0; MAX_SERIAL_OUTPUT],
            output_len: 0,
            overflow: false,
        }
    }

    fn load_input(&mut self, input: &[u8]) {
        self.input[..input.len()].copy_from_slice(input);
        self.input_len = input.len();
        self.input_position = 0;
    }

    fn output(&self) -> &[u8] {
        &self.output[..self.output_len]
    }
}

impl Console for FixedConsole {
    fn receive(&mut self) -> Option<u8> {
        if self.input_position >= self.input_len {
            return None;
        }
        let byte = self.input[self.input_position];
        self.input_position += 1;
        Some(byte)
    }

    fn transmit(&mut self, byte: u8) {
        if let Some(output) = self.output.get_mut(self.output_len) {
            *output = byte;
            self.output_len += 1;
        } else {
            self.overflow = true;
        }
    }

    fn reset(&mut self) {
        self.input_len = 0;
        self.input_position = 0;
        self.output_len = 0;
        self.overflow = false;
    }
}

struct FixedStore {
    present: bool,
    image: [u8; SECTOR_BYTES],
}

impl FixedStore {
    fn new(image: Option<ByteImage>) -> Self {
        let mut store = Self {
            present: image.is_some(),
            image: [0; SECTOR_BYTES],
        };
        if let Some(image) = image {
            image.materialize(&mut store.image);
        }
        store
    }

    fn digest(&self) -> Option<[u8; 32]> {
        self.present.then(|| sha256(&self.image))
    }
}

impl SectorStore for FixedStore {
    fn drive_info(&self, drive: u8) -> Option<DriveInfo> {
        (self.present && drive == 0).then_some(DriveInfo {
            sectors: 1,
            writable: true,
        })
    }

    fn read_sector(
        &mut self,
        drive: u8,
        lba: u32,
        output: &mut [u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        if self.present && drive == 0 && lba == 0 {
            output.copy_from_slice(&self.image);
            Ok(())
        } else {
            Err(StorageFault)
        }
    }

    fn write_sector(
        &mut self,
        drive: u8,
        lba: u32,
        input: &[u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        if self.present && drive == 0 && lba == 0 {
            self.image.copy_from_slice(input);
            Ok(())
        } else {
            Err(StorageFault)
        }
    }

    fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
        if self.present && drive == 0 {
            Ok(())
        } else {
            Err(StorageFault)
        }
    }
}

const EMPTY_IO: IoOperation = IoOperation {
    direction: IoDirection::Read,
    port: 0,
    value: 0,
};

struct FixedObserver {
    operations: [IoOperation; MAX_IO_OPERATIONS],
    len: usize,
    overflow: bool,
}

impl FixedObserver {
    const fn new() -> Self {
        Self {
            operations: [EMPTY_IO; MAX_IO_OPERATIONS],
            len: 0,
            overflow: false,
        }
    }

    fn operations(&self) -> &[IoOperation] {
        &self.operations[..self.len]
    }
}

impl IoObserver for FixedObserver {
    fn observe(&mut self, operation: IoOperation) {
        if let Some(slot) = self.operations.get_mut(self.len) {
            *slot = operation;
            self.len += 1;
        } else {
            self.overflow = true;
        }
    }
}

struct FixtureHost {
    console: FixedConsole,
    store: FixedStore,
    observer: FixedObserver,
}

impl FixtureHost {
    fn new(fixture: &Fixture) -> Self {
        Self {
            console: FixedConsole::new(),
            store: FixedStore::new(fixture.drive),
            observer: FixedObserver::new(),
        }
    }
}

#[cfg(test)]
extern crate std;

#[cfg(test)]
mod tests {
    use super::*;
    use std::boxed::Box;

    #[test]
    fn all_embedded_fixtures_match_the_checked_results() {
        let mut ram = Box::new([0; RAM_BYTES]);
        let mut events = 0;
        let summary = run_all(&mut ram, |event| {
            events += 1;
            if let FixtureEvent::Failed(failure) = event {
                panic!("embedded fixture failed: {failure:?}");
            }
        });
        assert_eq!(events, FIXTURE_COUNT);
        assert_eq!(summary.passed, FIXTURE_COUNT);
        assert_eq!(summary.failed, 0);
    }
}
