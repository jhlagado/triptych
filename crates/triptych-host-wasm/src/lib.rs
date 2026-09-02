//! Headless JavaScript boundary for the portable Triptych CPU machine.

use std::collections::VecDeque;

use triptych_cpu_core::{
    Console, CpuFlags, CpuState, Devices, DriveInfo, InterruptRequest, IoDirection, IoObserver,
    IoOperation, Machine, MachineMemory, RunBudget, RunReason, SectorStore, StorageFault,
    BOOT_ROM_BYTES, RAM_BYTES, SECTOR_BYTES,
};
use wasm_bindgen::prelude::*;

const RUN_HALTED: u8 = 0;
const RUN_STEP_LIMIT: u8 = 1;
const RUN_TSTATE_LIMIT: u8 = 2;

#[wasm_bindgen]
pub struct TriptychCpu {
    machine: Machine,
    ram: Box<[u8; RAM_BYTES]>,
    boot_rom: [u8; BOOT_ROM_BYTES],
    console: WasmConsole,
    sectors: WasmSectorStore,
    observer: WasmObserver,
    has_run: bool,
    last_steps: u64,
    last_tstates: u64,
    last_halted: bool,
    last_interrupt_accepted: bool,
}

#[wasm_bindgen]
impl TriptychCpu {
    #[wasm_bindgen(constructor)]
    pub fn new(boot_rom: &[u8]) -> Result<TriptychCpu, JsError> {
        let boot_rom: [u8; BOOT_ROM_BYTES] = boot_rom
            .try_into()
            .map_err(|_| JsError::new("boot ROM must contain exactly 256 bytes"))?;
        Ok(Self {
            machine: Machine::new(),
            ram: vec![0; RAM_BYTES]
                .into_boxed_slice()
                .try_into()
                .expect("fixed RAM allocation has the requested length"),
            boot_rom,
            console: WasmConsole::default(),
            sectors: WasmSectorStore::default(),
            observer: WasmObserver::default(),
            has_run: false,
            last_steps: 0,
            last_tstates: 0,
            last_halted: false,
            last_interrupt_accepted: false,
        })
    }

    /// Install or replace one drive before the first instruction executes.
    pub fn install_drive(
        &mut self,
        drive: u8,
        image: &[u8],
        writable: bool,
    ) -> Result<(), JsError> {
        if self.has_run {
            return Err(JsError::new(
                "drive media cannot change after execution; construct a fresh machine",
            ));
        }
        self.sectors.install(drive, image, writable)
    }

    pub fn export_drive(&self, drive: u8) -> Result<Vec<u8>, JsError> {
        self.sectors
            .drive(drive)
            .map(|drive| drive.bytes.clone())
            .ok_or_else(|| JsError::new("drive is not installed"))
    }

    pub fn reset(&mut self) {
        let mut devices = Devices::new(&mut self.console, &mut self.sectors);
        self.machine.reset(&mut devices);
        self.observer.operations.clear();
        self.last_steps = 0;
        self.last_tstates = 0;
        self.last_halted = false;
        self.last_interrupt_accepted = false;
    }

    /// Enable or disable retention of the ordered I/O trace. Tracing is off by
    /// default so a long-lived host cannot accumulate an unbounded diagnostic
    /// buffer when it has no trace consumer.
    pub fn set_io_trace_enabled(&mut self, enabled: bool) {
        self.observer.set_enabled(enabled);
    }

    /// Execute one complete instruction, then optionally present the proven
    /// `$FF` maskable interrupt at that instruction boundary.
    pub fn step(&mut self, maskable_interrupt_ff: bool) -> u32 {
        self.has_run = true;
        let interrupt = if maskable_interrupt_ff {
            InterruptRequest::MaskableFf
        } else {
            InterruptRequest::None
        };
        let result = {
            let mut memory = MachineMemory::new(&mut self.ram, &self.boot_rom);
            let mut devices = Devices::new(&mut self.console, &mut self.sectors)
                .with_observer(&mut self.observer);
            self.machine.step(&mut memory, &mut devices, interrupt)
        };
        self.last_steps = 1;
        self.last_tstates = u64::from(result.tstates);
        self.last_halted = result.halted;
        self.last_interrupt_accepted = result.interrupt_accepted;
        result.tstates
    }

    /// Run a bounded slice. The return value is `0` for HALT, `1` for the step
    /// limit, or `2` for the T-state limit.
    pub fn run_slice(&mut self, max_steps: u32, max_tstates: u32) -> Result<u8, JsError> {
        let budget = RunBudget::from_values(u64::from(max_steps), u64::from(max_tstates))
            .ok_or_else(|| JsError::new("run budgets must both be non-zero"))?;
        self.has_run = true;
        let exit = {
            let mut memory = MachineMemory::new(&mut self.ram, &self.boot_rom);
            let mut devices = Devices::new(&mut self.console, &mut self.sectors)
                .with_observer(&mut self.observer);
            self.machine.run_slice(&mut memory, &mut devices, budget)
        };
        self.last_steps = exit.steps;
        self.last_tstates = exit.tstates;
        self.last_halted = exit.reason == RunReason::Halted;
        self.last_interrupt_accepted = false;
        Ok(match exit.reason {
            RunReason::Halted => RUN_HALTED,
            RunReason::StepLimit => RUN_STEP_LIMIT,
            RunReason::TStateLimit => RUN_TSTATE_LIMIT,
        })
    }

    pub fn enqueue_serial_input(&mut self, bytes: &[u8]) {
        self.console.input.extend(bytes.iter().copied());
    }

    pub fn serial_output(&self) -> Vec<u8> {
        self.console.output.clone()
    }

    pub fn take_serial_output(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.console.output)
    }

    pub fn read_ram(&self, address: u32, length: u32) -> Result<Vec<u8>, JsError> {
        let range = checked_range(address, length)?;
        Ok(self.ram[range].to_vec())
    }

    pub fn write_ram(&mut self, address: u32, bytes: &[u8]) -> Result<(), JsError> {
        let length =
            u32::try_from(bytes.len()).map_err(|_| JsError::new("RAM write is too large"))?;
        let range = checked_range(address, length)?;
        self.ram[range].copy_from_slice(bytes);
        Ok(())
    }

    pub fn ram_image(&self) -> Vec<u8> {
        self.ram.to_vec()
    }

    pub fn boot_rom_enabled(&self) -> bool {
        self.machine.boot_rom_enabled()
    }

    pub fn cpu_state(&self) -> WasmCpuState {
        WasmCpuState(self.machine.cpu_state())
    }

    /// Test-only architectural state patch applied immediately before reset.
    #[cfg(feature = "conformance")]
    pub fn set_conformance_cpu_field(&mut self, field: &str, value: u32) -> Result<(), JsError> {
        let mut state = self.machine.cpu_state();
        set_cpu_field(&mut state, field, value)?;
        self.machine.install_conformance_cpu_state(state);
        Ok(())
    }

    pub fn last_steps(&self) -> u64 {
        self.last_steps
    }

    pub fn last_tstates(&self) -> u64 {
        self.last_tstates
    }

    pub fn last_halted(&self) -> bool {
        self.last_halted
    }

    pub fn last_interrupt_accepted(&self) -> bool {
        self.last_interrupt_accepted
    }

    /// Return and clear packed retained I/O operations. Bits 0..7 are the byte,
    /// bits 8..23 are the full port, and bit 24 is one for writes and zero for
    /// reads. Returns an empty vector while tracing is disabled.
    pub fn take_io_trace(&mut self) -> Vec<u32> {
        std::mem::take(&mut self.observer.operations)
            .into_iter()
            .map(pack_io)
            .collect()
    }
}

fn checked_range(address: u32, length: u32) -> Result<std::ops::Range<usize>, JsError> {
    let end = address
        .checked_add(length)
        .filter(|end| *end <= RAM_BYTES as u32)
        .ok_or_else(|| JsError::new("RAM range exceeds 64 KiB"))?;
    Ok(address as usize..end as usize)
}

#[derive(Default)]
struct WasmConsole {
    input: VecDeque<u8>,
    output: Vec<u8>,
}

impl Console for WasmConsole {
    fn receive(&mut self) -> Option<u8> {
        self.input.pop_front()
    }

    fn transmit(&mut self, byte: u8) {
        self.output.push(byte);
    }

    fn reset(&mut self) {
        self.input.clear();
        self.output.clear();
    }
}

struct WasmDrive {
    bytes: Vec<u8>,
    writable: bool,
}

#[derive(Default)]
struct WasmSectorStore {
    drives: Vec<Option<WasmDrive>>,
}

impl WasmSectorStore {
    fn install(&mut self, drive: u8, image: &[u8], writable: bool) -> Result<(), JsError> {
        if image.is_empty() || image.len() % SECTOR_BYTES != 0 {
            return Err(JsError::new(
                "drive must contain a non-empty whole number of 512-byte sectors",
            ));
        }
        let sectors = u32::try_from(image.len() / SECTOR_BYTES)
            .map_err(|_| JsError::new("drive is too large"))?;
        if sectors.checked_mul(4).is_none() {
            return Err(JsError::new("drive exceeds the 32-bit guest record space"));
        }
        let index = usize::from(drive);
        if self.drives.len() <= index {
            self.drives.resize_with(index + 1, || None);
        }
        self.drives[index] = Some(WasmDrive {
            bytes: image.to_vec(),
            writable,
        });
        Ok(())
    }

    fn drive(&self, drive: u8) -> Option<&WasmDrive> {
        self.drives.get(usize::from(drive))?.as_ref()
    }

    fn drive_mut(&mut self, drive: u8) -> Option<&mut WasmDrive> {
        self.drives.get_mut(usize::from(drive))?.as_mut()
    }
}

impl SectorStore for WasmSectorStore {
    fn drive_info(&self, drive: u8) -> Option<DriveInfo> {
        let drive = self.drive(drive)?;
        Some(DriveInfo {
            sectors: u32::try_from(drive.bytes.len() / SECTOR_BYTES).ok()?,
            writable: drive.writable,
        })
    }

    fn read_sector(
        &mut self,
        drive: u8,
        lba: u32,
        output: &mut [u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        let drive = self.drive(drive).ok_or(StorageFault)?;
        let start = usize::try_from(lba)
            .ok()
            .and_then(|lba| lba.checked_mul(SECTOR_BYTES))
            .ok_or(StorageFault)?;
        output.copy_from_slice(
            drive
                .bytes
                .get(start..start + SECTOR_BYTES)
                .ok_or(StorageFault)?,
        );
        Ok(())
    }

    fn write_sector(
        &mut self,
        drive: u8,
        lba: u32,
        input: &[u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        let drive = self.drive_mut(drive).ok_or(StorageFault)?;
        if !drive.writable {
            return Err(StorageFault);
        }
        let start = usize::try_from(lba)
            .ok()
            .and_then(|lba| lba.checked_mul(SECTOR_BYTES))
            .ok_or(StorageFault)?;
        drive
            .bytes
            .get_mut(start..start + SECTOR_BYTES)
            .ok_or(StorageFault)?
            .copy_from_slice(input);
        Ok(())
    }

    fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
        self.drive(drive).map(|_| ()).ok_or(StorageFault)
    }
}

#[derive(Default)]
struct WasmObserver {
    enabled: bool,
    operations: Vec<IoOperation>,
}

impl WasmObserver {
    fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
        self.operations.clear();
    }
}

impl IoObserver for WasmObserver {
    fn observe(&mut self, operation: IoOperation) {
        if self.enabled {
            self.operations.push(operation);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn operation(value: u8) -> IoOperation {
        IoOperation {
            direction: IoDirection::Read,
            port: 0x1234,
            value,
        }
    }

    #[test]
    fn io_observer_retains_operations_only_while_enabled() {
        let mut observer = WasmObserver::default();
        observer.observe(operation(1));
        assert!(observer.operations.is_empty());

        observer.set_enabled(true);
        observer.observe(operation(2));
        assert_eq!(observer.operations, [operation(2)]);

        observer.set_enabled(false);
        assert!(observer.operations.is_empty());
        observer.observe(operation(3));
        assert!(observer.operations.is_empty());
    }
}

fn pack_io(operation: IoOperation) -> u32 {
    let direction = match operation.direction {
        IoDirection::Read => 0,
        IoDirection::Write => 1 << 24,
    };
    direction | (u32::from(operation.port) << 8) | u32::from(operation.value)
}

#[wasm_bindgen]
pub struct WasmCpuState(CpuState);

macro_rules! cpu_getters {
    ($($name:ident: $type:ty),* $(,)?) => {
        #[wasm_bindgen]
        impl WasmCpuState {
            $(pub fn $name(&self) -> $type { self.0.$name })*
        }
    };
}

cpu_getters! {
    a: u8, b: u8, c: u8, d: u8, e: u8, h: u8, l: u8,
    a_prime: u8, b_prime: u8, c_prime: u8, d_prime: u8,
    e_prime: u8, h_prime: u8, l_prime: u8,
    ix: u16, iy: u16, i: u8, r: u8, sp: u16, pc: u16, imode: u8,
    iff1: bool, iff2: bool, halted: bool,
}

#[wasm_bindgen]
impl WasmCpuState {
    pub fn flags(&self) -> WasmCpuFlags {
        WasmCpuFlags(self.0.f)
    }

    pub fn flags_prime(&self) -> WasmCpuFlags {
        WasmCpuFlags(self.0.f_prime)
    }
}

#[wasm_bindgen]
pub struct WasmCpuFlags(CpuFlags);

macro_rules! flag_getters {
    ($($name:ident),* $(,)?) => {
        #[wasm_bindgen]
        impl WasmCpuFlags {
            $(pub fn $name(&self) -> bool { self.0.$name })*
        }
    };
}

flag_getters!(s, z, y, h, x, p, n, c);

#[cfg(feature = "conformance")]
fn set_cpu_field(state: &mut CpuState, field: &str, value: u32) -> Result<(), JsError> {
    let byte = || u8::try_from(value).map_err(|_| JsError::new("CPU byte exceeds 255"));
    let word = || u16::try_from(value).map_err(|_| JsError::new("CPU word exceeds 65535"));
    let boolean = || match value {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(JsError::new("CPU boolean must be zero or one")),
    };
    match field {
        "a" => state.a = byte()?,
        "b" => state.b = byte()?,
        "c" => state.c = byte()?,
        "d" => state.d = byte()?,
        "e" => state.e = byte()?,
        "h" => state.h = byte()?,
        "l" => state.l = byte()?,
        "a_prime" => state.a_prime = byte()?,
        "b_prime" => state.b_prime = byte()?,
        "c_prime" => state.c_prime = byte()?,
        "d_prime" => state.d_prime = byte()?,
        "e_prime" => state.e_prime = byte()?,
        "h_prime" => state.h_prime = byte()?,
        "l_prime" => state.l_prime = byte()?,
        "i" => state.i = byte()?,
        "r" => state.r = byte()?,
        "ix" => state.ix = word()?,
        "iy" => state.iy = word()?,
        "sp" => state.sp = word()?,
        "pc" => state.pc = word()?,
        "imode" if value <= 2 => state.imode = value as u8,
        "iff1" => state.iff1 = boolean()?,
        "iff2" => state.iff2 = boolean()?,
        "halted" => state.halted = boolean()?,
        value if value.starts_with("f_prime.") => {
            set_flag(&mut state.f_prime, &value[8..], boolean()?)?
        }
        value if value.starts_with("f.") => set_flag(&mut state.f, &value[2..], boolean()?)?,
        "imode" => return Err(JsError::new("interrupt mode must be zero, one, or two")),
        _ => return Err(JsError::new("unknown CPU conformance field")),
    }
    Ok(())
}

#[cfg(feature = "conformance")]
fn set_flag(flags: &mut CpuFlags, name: &str, value: bool) -> Result<(), JsError> {
    match name {
        "s" => flags.s = value,
        "z" => flags.z = value,
        "y" => flags.y = value,
        "h" => flags.h = value,
        "x" => flags.x = value,
        "p" => flags.p = value,
        "n" => flags.n = value,
        "c" => flags.c = value,
        _ => return Err(JsError::new("unknown CPU flag")),
    }
    Ok(())
}
