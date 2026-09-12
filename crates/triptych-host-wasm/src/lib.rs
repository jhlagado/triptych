//! Headless JavaScript boundary for the portable Triptych CPU machine.

mod files;
pub use files::CpmDisk;

use std::collections::VecDeque;

use triptych_cpu_core::{
    Console, CpuFlags, CpuState, Devices, DiskState, DriveInfo, InterruptRequest, IoDirection,
    IoObserver, IoOperation, Machine, MachineMemory, RunBudget, RunReason, SectorStore,
    StorageFault, BOOT_ROM_BYTES, RAM_BYTES, SECTOR_BYTES,
};
use wasm_bindgen::prelude::*;

const RUN_HALTED: u8 = 0;
const RUN_STEP_LIMIT: u8 = 1;
const RUN_TSTATE_LIMIT: u8 = 2;
const RUN_MEDIA_FROZEN: u8 = 3;
const RUN_SYSTEM_RECOVERY: u8 = 4;
const SYSTEM_RESIDENT_BYTES: usize = 52 * 128;
const SYSTEM_BIOS_OFFSET: usize = 44 * 128;
const RECOVERY_NONE: u8 = 0;
const RECOVERY_WARM_BOOT: u8 = 1;
const RECOVERY_COLD_RESET: u8 = 2;
const MAX_SERIAL_INPUT_BYTES: usize = 16 * 1024;
const MEDIA_SLOTS: u8 = 16;

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
    pending_media: Option<PreparedMediaChange>,
    last_media_ticket: u32,
    system_guard: Option<SystemGuard>,
    system_recovery: u8,
}

struct SystemGuard {
    resident: Vec<u8>,
    image_bytes: usize,
    bios_base: u16,
    warm_entry: u16,
}

struct PreparedMediaChange {
    ticket: u32,
    drive: u8,
    replacement: Option<WasmDrive>,
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
            pending_media: None,
            last_media_ticket: 0,
            system_guard: None,
            system_recovery: RECOVERY_NONE,
        })
    }

    /// Opt into the known Triptych CP/M boot-entry guard, once before execution.
    /// The caller must first authenticate the exact bootstrap/system tuple. This
    /// method validates structure, not release provenance: exactly 52 resident
    /// records, a page-aligned BIOS, 17 in-range JP entries and DI/LD SP prologues.
    /// Installed A must match, and its exact image size becomes part of the guard.
    /// No guest ports are added; unknown boot formats must not opt into this API.
    pub fn configure_system_guard(&mut self, resident: &[u8], bios_base: u32) -> bool {
        if self.has_run
            || self.media_change_pending()
            || self.system_guard.is_some()
            || resident.len() != SYSTEM_RESIDENT_BYTES
            || bios_base % 256 != 0
            || bios_base < SYSTEM_BIOS_OFFSET as u32 + 256
            || bios_base
                .checked_add(1024)
                .is_none_or(|end| end > RAM_BYTES as u32)
        {
            return false;
        }
        let Some(drive) = self.sectors.drive(0) else {
            return false;
        };
        if drive.bytes.get(..SYSTEM_RESIDENT_BYTES) != Some(resident) {
            return false;
        }
        let entry = |index: usize| -> Option<u16> {
            let offset = SYSTEM_BIOS_OFFSET + index * 3;
            if resident[offset] != 0xc3 {
                return None;
            }
            let target = u16::from_le_bytes([resident[offset + 1], resident[offset + 2]]);
            (u32::from(target) >= bios_base + 51 && u32::from(target) < bios_base + 768)
                .then_some(target)
        };
        if (0..17).any(|index| entry(index).is_none()) {
            return false;
        }
        let cold = entry(0).unwrap();
        let warm = entry(1).unwrap();
        if warm <= cold {
            return false;
        }
        for target in [cold, warm] {
            let offset = SYSTEM_BIOS_OFFSET + usize::from(target) - bios_base as usize;
            if resident.get(offset..offset + 2) != Some(&[0xf3, 0x31]) {
                return false;
            }
        }
        let mut owned = Vec::new();
        if owned.try_reserve_exact(resident.len()).is_err() {
            return false;
        }
        owned.extend_from_slice(resident);
        self.system_guard = Some(SystemGuard {
            resident: owned,
            image_bytes: drive.bytes.len(),
            bios_base: bios_base as u16,
            warm_entry: warm,
        });
        true
    }

    /// Zero means no recovery request, 1 a paused warm boot, 2 a deferred reset.
    /// The latch is independent of media tickets and survives backing replacement.
    pub fn system_recovery_pending(&self) -> u8 {
        self.system_recovery
    }

    /// Compare current A with the admitted resident prefix and exact image size.
    /// A dirty cached system sector is conservatively incompatible until flushed.
    /// This is false when no system guard has been configured.
    pub fn system_disk_matches(&self) -> bool {
        let Some(guard) = self.system_guard.as_ref() else {
            return false;
        };
        let state = self.machine.disk_state();
        if state.cache_dirty
            && state.cache_drive == Some(0)
            && state
                .cache_sector
                .is_some_and(|sector| sector < (SYSTEM_RESIDENT_BYTES / SECTOR_BYTES) as u32)
        {
            return false;
        }
        self.sectors.drive(0).is_some_and(|drive| {
            drive.bytes.len() == guard.image_bytes
                && drive.bytes.get(..SYSTEM_RESIDENT_BYTES) == Some(guard.resident.as_slice())
        })
    }

    /// Complete an explicit, durably published restoration of the retained system
    /// binding. Replacement alone never unpauses execution. No allocation occurs.
    /// Warm boot keeps its exact PC/CPU/RAM; a requested reset is replayed only here.
    /// Dirty/partial/unflushed storage or queued input leaves recovery intact.
    pub fn complete_system_disk_restore(&mut self) -> bool {
        if self.system_recovery == RECOVERY_NONE
            || !self.system_disk_matches()
            || !self.disk_management_ready()
        {
            return false;
        }
        let reset = self.system_recovery == RECOVERY_COLD_RESET;
        self.system_recovery = RECOVERY_NONE;
        if reset {
            self.reset();
        }
        true
    }

    /// Install or replace one drive before the first instruction executes.
    pub fn install_drive(
        &mut self,
        drive: u8,
        image: &[u8],
        writable: bool,
    ) -> Result<(), JsError> {
        self.require_media_unfrozen()?;
        if self.has_run {
            return Err(JsError::new(
                "drive media cannot change after execution; construct a fresh machine",
            ));
        }
        self.sectors.install(drive, image, writable)
    }

    /// Own incoming media and freeze the machine before durable host publication.
    /// Returns a per-instance monotonically increasing nonzero ticket, or zero for invalid
    /// media/slot, allocation failure, exhausted tickets, pending input, unflushed
    /// storage or an existing ticket. This API admits slots A-P only; historical
    /// pre-execution install_drive retains its wider controller address domain.
    ///
    /// Readiness does NOT prove filesystem consistency. The caller must arrange
    /// guest file closure/flush, and BDOS drive reset/reopen after the swap.
    /// Persist the outgoing checkpoint and intended binding before commit.
    pub fn prepare_drive_change(&mut self, drive: u8, image: &[u8], writable: bool) -> u32 {
        if drive >= MEDIA_SLOTS || !self.disk_management_ready() {
            return 0;
        }
        let Some(ticket) = self.last_media_ticket.checked_add(1) else {
            return 0;
        };
        let Some(replacement) = WasmDrive::prepare(image, writable) else {
            return 0;
        };
        self.freeze_media(ticket, drive, Some(replacement))
    }

    /// Prepare ejection without discarding the outgoing backing or checkpoint.
    /// Zero rejects unavailable slots or any readiness/ticket failure.
    pub fn prepare_drive_eject(&mut self, drive: u8) -> u32 {
        if drive >= MEDIA_SLOTS
            || !self.disk_management_ready()
            || self.sectors.drive(drive).is_none()
        {
            return 0;
        }
        let Some(ticket) = self.last_media_ticket.checked_add(1) else {
            return 0;
        };
        self.freeze_media(ticket, drive, None)
    }

    pub fn media_change_pending(&self) -> bool {
        self.pending_media.is_some()
    }

    /// Publish the already allocated backing without resetting CPU or RAM.
    /// A wrong/stale ticket leaves the machine frozen. On an unexpected failure
    /// after durable publication, keep it paused and reload committed host state;
    /// never cancel back to obsolete media. This method performs no allocation.
    pub fn commit_media_change(&mut self, ticket: u32) -> bool {
        if !self
            .pending_media
            .as_ref()
            .is_some_and(|pending| pending.ticket == ticket)
        {
            return false;
        }
        if !self.machine.prepare_media_change() {
            return false;
        }
        if let Some(pending) = self.pending_media.take() {
            self.sectors.drives[usize::from(pending.drive)] = pending.replacement;
            return true;
        }
        false
    }

    /// Cancel only before host publication: retain old media, controller and CPU.
    /// Wrong/stale tickets do not unfreeze the machine.
    pub fn cancel_media_change(&mut self, ticket: u32) -> bool {
        if !self
            .pending_media
            .as_ref()
            .is_some_and(|pending| pending.ticket == ticket)
        {
            return false;
        }
        self.pending_media = None;
        true
    }

    /// Export live backing sectors, which can include writes after the last flush.
    /// This is not a consistent durability checkpoint; it also excludes dirty
    /// controller cache data that has not reached the backing store.
    pub fn export_drive(&self, drive: u8) -> Result<Vec<u8>, JsError> {
        self.sectors
            .drive(drive)
            .map(|drive| drive.bytes.clone())
            .ok_or_else(|| JsError::new("drive is not installed"))
    }

    /// Export an independent copy of the initial image or the exact image at the
    /// last successful guest flush. Later writes cannot change this checkpoint.
    /// A guest flush does not imply that browser storage has saved these bytes.
    /// Protected disks export their immutable backing directly into an owned copy.
    pub fn export_drive_checkpoint(&self, drive: u8) -> Result<Vec<u8>, JsError> {
        self.sectors
            .drive(drive)
            .map(|drive| {
                if drive.writable {
                    drive.checkpoint.clone()
                } else {
                    drive.bytes.clone()
                }
            })
            .ok_or_else(|| JsError::new("drive is not installed"))
    }

    /// Whether storage and terminal input are quiescent at this instruction boundary.
    ///
    /// The host must stop scheduling execution and accepting input before testing
    /// this guard. It does not prove that an application has saved its RAM, exited,
    /// or finished a logical multi-command filesystem update. Obtain explicit
    /// save-and-exit confirmation before replacing the CPU. No state is changed.
    pub fn disk_management_ready(&self) -> bool {
        !self.media_change_pending()
            && controller_allows_disk_management(self.machine.disk_state())
            && self.console.input.is_empty()
            && !self.machine.console_input_pending()
            && self
                .sectors
                .drives
                .iter()
                .flatten()
                .all(|drive| !drive.writes_since_flush)
    }

    /// Count successful guest flush commands for one installed drive.
    ///
    /// Browser storage uses this edge with `export_drive_checkpoint`, never the
    /// live backing export, to obtain bytes at the guest flush boundary.
    pub fn drive_flush_count(&self, drive: u8) -> Result<u32, JsError> {
        self.sectors
            .drive(drive)
            .map(|drive| drive.flush_count)
            .ok_or_else(|| JsError::new("drive is not installed"))
    }

    /// While a media ticket is pending, reset is a no-op, including counters.
    pub fn reset(&mut self) {
        if self.media_change_pending() {
            return;
        }
        if self.system_guard.is_some()
            && (self.system_recovery != RECOVERY_NONE || !self.system_disk_matches())
        {
            self.system_recovery = RECOVERY_COLD_RESET;
            return;
        }
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
    /// Frozen calls are no-ops and preserve the retained trace.
    pub fn set_io_trace_enabled(&mut self, enabled: bool) {
        if self.execution_frozen() {
            return;
        }
        self.observer.set_enabled(enabled);
    }

    /// Execute one complete instruction, then optionally present the proven
    /// `$FF` maskable interrupt at that instruction boundary.
    /// While frozen, returns zero without changing execution or last-run counters.
    pub fn step(&mut self, maskable_interrupt_ff: bool) -> u32 {
        if self.media_change_pending() || self.guard_system_execution() {
            return 0;
        }
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
    /// limit, `2` for the T-state limit, `3` for a pending media ticket, or `4`
    /// for system-disk recovery. Guarded execution checks every instruction.
    /// Frozen calls leave all state and last-run counters unchanged.
    pub fn run_slice(&mut self, max_steps: u32, max_tstates: u32) -> Result<u8, JsError> {
        if self.media_change_pending() {
            return Ok(RUN_MEDIA_FROZEN);
        }
        if self.guard_system_execution() {
            return Ok(RUN_SYSTEM_RECOVERY);
        }
        let budget = RunBudget::from_values(u64::from(max_steps), u64::from(max_tstates))
            .ok_or_else(|| JsError::new("run budgets must both be non-zero"))?;
        self.has_run = true;
        if self.system_guard.is_some() {
            return Ok(self.run_guarded_slice(max_steps, max_tstates));
        }
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

    /// Enqueue one complete host input batch, or reject it without accepting a
    /// prefix when the bounded console queue has insufficient room.
    pub fn enqueue_serial_input(&mut self, bytes: &[u8]) -> bool {
        if self.execution_frozen() {
            return false;
        }
        let Some(length) = self.console.input.len().checked_add(bytes.len()) else {
            return false;
        };
        if length > MAX_SERIAL_INPUT_BYTES {
            return false;
        }
        self.console.input.extend(bytes.iter().copied());
        true
    }

    pub fn serial_output(&self) -> Vec<u8> {
        self.console.output.clone()
    }

    /// While frozen, return empty without draining the retained output.
    pub fn take_serial_output(&mut self) -> Vec<u8> {
        if self.execution_frozen() {
            return Vec::new();
        }
        std::mem::take(&mut self.console.output)
    }

    pub fn read_ram(&self, address: u32, length: u32) -> Result<Vec<u8>, JsError> {
        let range = checked_range(address, length)?;
        Ok(self.ram[range].to_vec())
    }

    /// Reject writes while a media ticket freezes the machine.
    pub fn write_ram(&mut self, address: u32, bytes: &[u8]) -> Result<(), JsError> {
        self.require_media_unfrozen()?;
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
        self.require_media_unfrozen()?;
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
    /// While frozen, returns empty without draining retained operations.
    pub fn take_io_trace(&mut self) -> Vec<u32> {
        if self.execution_frozen() {
            return Vec::new();
        }
        std::mem::take(&mut self.observer.operations)
            .into_iter()
            .map(pack_io)
            .collect()
    }
}

impl TriptychCpu {
    fn execution_frozen(&self) -> bool {
        self.media_change_pending() || self.system_recovery != RECOVERY_NONE
    }

    fn guard_system_execution(&mut self) -> bool {
        if self.system_recovery != RECOVERY_NONE {
            return true;
        }
        let Some(guard) = self.system_guard.as_ref() else {
            return false;
        };
        let rom = self.machine.boot_rom_enabled();
        let pc = self.machine.cpu_state().pc;
        if (rom || pc == 0 || pc == guard.bios_base + 3 || pc == guard.warm_entry)
            && !self.system_disk_matches()
        {
            self.system_recovery = if rom {
                RECOVERY_COLD_RESET
            } else {
                RECOVERY_WARM_BOOT
            };
            return true;
        }
        false
    }

    fn run_guarded_slice(&mut self, max_steps: u32, max_tstates: u32) -> u8 {
        let mut steps = 0;
        let mut tstates = 0;
        let reason = if self.machine.cpu_state().halted {
            RUN_HALTED
        } else {
            loop {
                let elapsed = self.step(false);
                if self.system_recovery != RECOVERY_NONE {
                    break RUN_SYSTEM_RECOVERY;
                }
                steps += 1;
                tstates += u64::from(elapsed);
                if self.last_halted {
                    break RUN_HALTED;
                }
                if steps >= u64::from(max_steps) {
                    break RUN_STEP_LIMIT;
                }
                if tstates >= u64::from(max_tstates) {
                    break RUN_TSTATE_LIMIT;
                }
            }
        };
        self.last_steps = steps;
        self.last_tstates = tstates;
        self.last_halted = reason == RUN_HALTED;
        self.last_interrupt_accepted = false;
        reason
    }

    fn require_media_unfrozen(&self) -> Result<(), JsError> {
        if self.execution_frozen() {
            return Err(JsError::new(
                "machine is frozen for media change or system recovery",
            ));
        }
        Ok(())
    }

    fn freeze_media(&mut self, ticket: u32, drive: u8, replacement: Option<WasmDrive>) -> u32 {
        let length = usize::from(drive) + 1;
        if self.sectors.drives.len() < length {
            if self
                .sectors
                .drives
                .try_reserve_exact(length - self.sectors.drives.len())
                .is_err()
            {
                return 0;
            }
            self.sectors.drives.resize_with(length, || None);
        }
        self.pending_media = Some(PreparedMediaChange {
            ticket,
            drive,
            replacement,
        });
        self.last_media_ticket = ticket;
        ticket
    }
}

fn controller_allows_disk_management(state: DiskState) -> bool {
    !state.cache_dirty && state.transfer_position.is_none() && state.error == 0
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
    // Protected media has only the immutable backing allocation. The checkpoint
    // and dirty tracking vectors below stay empty with zero capacity.
    checkpoint: Vec<u8>,
    writable: bool,
    flush_count: u32,
    writes_since_flush: bool,
    // One membership bit and at most one queued index per backing sector.
    // Both buffers are allocated at installation, so writes/flushes allocate
    // nothing and repeated writes cannot grow the pending list.
    dirty_sector_bits: Vec<u8>,
    dirty_sectors: Vec<u32>,
    #[cfg(test)]
    checkpoint_copied_bytes: u64,
}

impl WasmDrive {
    // Fallible preparation owns every buffer before the caller publishes durable
    // bindings. Neither commit nor later writes/flushes need to reserve capacity.
    fn prepare(image: &[u8], writable: bool) -> Option<Self> {
        if image.is_empty() || image.len() % SECTOR_BYTES != 0 {
            return None;
        }
        let sectors = image.len() / SECTOR_BYTES;
        u32::try_from(sectors).ok()?.checked_mul(4)?;
        let mut bytes = Vec::new();
        bytes.try_reserve_exact(image.len()).ok()?;
        bytes.extend_from_slice(image);
        let mut checkpoint = Vec::new();
        let mut dirty_sector_bits = Vec::new();
        let mut dirty_sectors = Vec::new();
        if writable {
            checkpoint.try_reserve_exact(image.len()).ok()?;
            checkpoint.extend_from_slice(image);
            dirty_sector_bits
                .try_reserve_exact(sectors.div_ceil(8))
                .ok()?;
            dirty_sector_bits.resize(sectors.div_ceil(8), 0);
            dirty_sectors.try_reserve_exact(sectors).ok()?;
        }
        Some(Self {
            bytes,
            checkpoint,
            writable,
            flush_count: 0,
            writes_since_flush: false,
            dirty_sector_bits,
            dirty_sectors,
            #[cfg(test)]
            checkpoint_copied_bytes: 0,
        })
    }
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
        let prepared = WasmDrive::prepare(image, writable)
            .ok_or_else(|| JsError::new("drive allocation failed"))?;
        let index = usize::from(drive);
        if self.drives.len() <= index {
            self.drives.resize_with(index + 1, || None);
        }
        self.drives[index] = Some(prepared);
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
                .get(start..)
                .and_then(|bytes| bytes.get(..SECTOR_BYTES))
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
            .get_mut(start..)
            .and_then(|bytes| bytes.get_mut(..SECTOR_BYTES))
            .ok_or(StorageFault)?
            .copy_from_slice(input);
        let sector = start / SECTOR_BYTES;
        let mask = 1 << (sector % 8);
        if drive.dirty_sector_bits[sector / 8] & mask == 0 {
            drive.dirty_sector_bits[sector / 8] |= mask;
            drive.dirty_sectors.push(lba);
        }
        drive.writes_since_flush = true;
        Ok(())
    }

    fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
        let drive = self.drive_mut(drive).ok_or(StorageFault)?;
        for lba in drive.dirty_sectors.drain(..) {
            // Only successful, bounds-checked writes enqueue sector indices.
            let sector = lba as usize;
            let start = sector * SECTOR_BYTES;
            let range = start..start + SECTOR_BYTES;
            drive.checkpoint[range.clone()].copy_from_slice(&drive.bytes[range]);
            drive.dirty_sector_bits[sector / 8] &= !(1 << (sector % 8));
            #[cfg(test)]
            {
                drive.checkpoint_copied_bytes += SECTOR_BYTES as u64;
            }
        }
        drive.writes_since_flush = false;
        drive.flush_count = drive.flush_count.wrapping_add(1);
        Ok(())
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
mod checkpoint_benchmark;

#[cfg(test)]
mod system_guard_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn readonly_media_owns_only_backing_and_exports_independent_checkpoints() {
        let mut cpu = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        let mut source = [7; SECTOR_BYTES * 9];
        cpu.install_drive(0, &source, false).unwrap();
        let ticket = cpu.prepare_drive_change(1, &source, false);
        assert_ne!(ticket, 0);
        assert!(cpu.commit_media_change(ticket));
        source.fill(9);
        for index in [0, 1] {
            let drive = cpu.sectors.drive(index).unwrap();
            assert_eq!(
                drive.checkpoint.capacity(),
                0,
                "readonly has no checkpoint allocation"
            );
            assert_eq!(
                drive.dirty_sector_bits.capacity(),
                0,
                "readonly has no dirty bitmap allocation"
            );
            assert_eq!(
                drive.dirty_sectors.capacity(),
                0,
                "readonly has no dirty queue allocation"
            );
            assert_eq!(drive.bytes, [7; SECTOR_BYTES * 9]);
            let mut exported = cpu.export_drive_checkpoint(index).unwrap();
            exported.fill(1);
            assert_eq!(
                cpu.export_drive_checkpoint(index).unwrap(),
                [7; SECTOR_BYTES * 9]
            );
            assert!(cpu
                .sectors
                .write_sector(index, 0, &[2; SECTOR_BYTES])
                .is_err());
            assert!(cpu
                .sectors
                .write_sector(index, 8, &[2; SECTOR_BYTES])
                .is_err());
            cpu.sectors.flush(index).unwrap();
            cpu.sectors.flush(index).unwrap();
            assert_eq!(cpu.drive_flush_count(index).unwrap(), 2);
            assert_eq!(cpu.export_drive(index).unwrap(), [7; SECTOR_BYTES * 9]);
            let drive = cpu.sectors.drive(index).unwrap();
            assert!(!drive.writes_since_flush);
            assert_eq!(drive.checkpoint_copied_bytes, 0);
            assert_eq!(drive.checkpoint.capacity(), 0);
            assert_eq!(drive.dirty_sector_bits.capacity(), 0);
            assert_eq!(drive.dirty_sectors.capacity(), 0);
        }
    }

    #[test]
    fn media_ticket_freezes_execution_and_cancel_retains_machine() {
        let mut cpu = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        cpu.install_drive(0, &[1; SECTOR_BYTES], true).unwrap();
        cpu.write_ram(400, &[9, 8, 7]).unwrap();
        cpu.step(false);
        let state = cpu.machine.cpu_state();
        let disk = cpu.machine.disk_state();
        let counters = (cpu.last_steps(), cpu.last_tstates());
        let ram = cpu.ram_image();
        cpu.console.output.push(42);
        cpu.observer.set_enabled(true);
        cpu.observer.observe(operation(7));
        let ticket = cpu.prepare_drive_change(0, &[2; SECTOR_BYTES], false);
        assert_ne!(ticket, 0);
        assert!(cpu.media_change_pending());
        assert!(!cpu.disk_management_ready());
        assert_eq!(cpu.step(true), 0);
        assert_eq!(cpu.run_slice(10, 100).unwrap(), 3);
        cpu.reset();
        cpu.set_io_trace_enabled(false);
        assert!(cpu.take_io_trace().is_empty());
        assert!(cpu.take_serial_output().is_empty());
        assert_eq!(cpu.serial_output(), [42]);
        assert_eq!(cpu.observer.operations, [operation(7)]);
        assert!(cpu.observer.enabled);
        assert!(!cpu.enqueue_serial_input(&[65]));
        assert_eq!(cpu.machine.cpu_state(), state);
        assert_eq!(cpu.machine.disk_state(), disk);
        assert_eq!((cpu.last_steps(), cpu.last_tstates()), counters);
        assert_eq!(cpu.ram_image(), ram);
        assert_eq!(cpu.export_drive(0).unwrap(), [1; SECTOR_BYTES]);
        assert_eq!(cpu.prepare_drive_eject(0), 0);
        assert!(!cpu.commit_media_change(ticket + 1));
        assert!(!cpu.cancel_media_change(ticket + 1));
        assert!(cpu.media_change_pending());
        assert!(cpu.cancel_media_change(ticket));
        assert!(!cpu.media_change_pending());
        assert_eq!(cpu.export_drive(0).unwrap(), [1; SECTOR_BYTES]);
        assert_eq!(cpu.machine.cpu_state(), state);
        assert_eq!(cpu.machine.disk_state(), disk);
        assert!(cpu.step(false) > 0);
    }

    #[test]
    fn media_ticket_commits_owned_protected_media_without_reallocation_or_reset() {
        let mut cpu = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        cpu.install_drive(0, &[1; SECTOR_BYTES], true).unwrap();
        cpu.step(false);
        let state = cpu.machine.cpu_state();
        let mut image = [2; SECTOR_BYTES];
        let ticket = cpu.prepare_drive_change(15, &image, false);
        assert_ne!(ticket, 0);
        image.fill(9);
        let prepared = cpu
            .pending_media
            .as_ref()
            .unwrap()
            .replacement
            .as_ref()
            .unwrap();
        let backing = prepared.bytes.as_ptr();
        let checkpoint = prepared.checkpoint.as_ptr();
        let slots = cpu.sectors.drives.as_ptr();
        assert!(cpu.commit_media_change(ticket));
        assert_eq!(cpu.sectors.drives.as_ptr(), slots);
        let installed = cpu.sectors.drive(15).unwrap();
        assert_eq!(installed.bytes.as_ptr(), backing);
        assert_eq!(installed.checkpoint.as_ptr(), checkpoint);
        assert_eq!(cpu.export_drive(15).unwrap(), [2; SECTOR_BYTES]);
        assert!(cpu.sectors.write_sector(15, 0, &[3; SECTOR_BYTES]).is_err());
        assert_eq!(cpu.machine.cpu_state(), state);
        assert!(!cpu.commit_media_change(ticket));
        let eject = cpu.prepare_drive_eject(15);
        assert!(eject > ticket);
        assert!(!cpu.cancel_media_change(ticket));
        assert!(cpu.commit_media_change(eject));
        assert!(cpu.sectors.drive_info(15).is_none());
        assert_eq!(cpu.machine.cpu_state(), state);
    }

    #[test]
    fn media_ticket_rejects_unflushed_input_invalid_media_and_exhaustion() {
        let mut cpu = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        cpu.install_drive(0, &[1; SECTOR_BYTES], true).unwrap();
        for drive in [16, 255] {
            assert_eq!(cpu.prepare_drive_change(drive, &[2; SECTOR_BYTES], true), 0);
            assert_eq!(cpu.prepare_drive_eject(drive), 0);
        }
        for image in [&[][..], &[0; 511][..]] {
            assert_eq!(cpu.prepare_drive_change(0, image, true), 0);
        }
        cpu.sectors.write_sector(0, 0, &[3; SECTOR_BYTES]).unwrap();
        assert_eq!(cpu.prepare_drive_eject(0), 0);
        cpu.sectors.flush(0).unwrap();
        assert!(cpu.enqueue_serial_input(&[65]));
        assert_eq!(cpu.prepare_drive_eject(0), 0);
        cpu.reset();
        let ticket = cpu.prepare_drive_eject(0);
        assert_ne!(ticket, 0);
        assert!(cpu.cancel_media_change(ticket));
        cpu.last_media_ticket = u32::MAX;
        assert_eq!(cpu.prepare_drive_eject(0), 0);
        assert!(!cpu.media_change_pending());
        assert_eq!(cpu.export_drive_checkpoint(0).unwrap(), [3; SECTOR_BYTES]);
    }

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

    #[test]
    fn wasm_sector_store_counts_successful_flushes_per_drive() {
        let mut sectors = WasmSectorStore::default();
        sectors.install(0, &[0; SECTOR_BYTES], true).unwrap();
        sectors.install(1, &[0; SECTOR_BYTES], true).unwrap();

        assert_eq!(sectors.drive(0).unwrap().flush_count, 0);
        SectorStore::flush(&mut sectors, 0).unwrap();
        SectorStore::flush(&mut sectors, 0).unwrap();
        SectorStore::flush(&mut sectors, 1).unwrap();

        assert_eq!(sectors.drive(0).unwrap().flush_count, 2);
        assert_eq!(sectors.drive(1).unwrap().flush_count, 1);
        assert!(SectorStore::flush(&mut sectors, 2).is_err());
    }

    #[test]
    fn checkpoint_excludes_writes_after_the_last_successful_flush() {
        let mut machine = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        machine.install_drive(0, &[0; SECTOR_BYTES], true).unwrap();
        machine
            .sectors
            .write_sector(0, 0, &[1; SECTOR_BYTES])
            .unwrap();
        machine.sectors.flush(0).unwrap();
        machine
            .sectors
            .write_sector(0, 0, &[2; SECTOR_BYTES])
            .unwrap();

        assert_eq!(machine.drive_flush_count(0).unwrap(), 1);
        assert_eq!(machine.export_drive(0).unwrap(), [2; SECTOR_BYTES]);
        assert_eq!(
            machine.export_drive_checkpoint(0).unwrap(),
            [1; SECTOR_BYTES]
        );
    }

    #[test]
    fn checkpoint_flush_copies_each_written_sector_once_and_reuses_tracking() {
        let mut store = WasmSectorStore::default();
        let original = vec![3; 17 * SECTOR_BYTES];
        store.install(0, &original, true).unwrap();
        let mut expected = original.clone();
        for (lba, value) in [(16, 4), (0, 5), (7, 6), (8, 7), (16, 8)] {
            store.write_sector(0, lba, &[value; SECTOR_BYTES]).unwrap();
            let start = lba as usize * SECTOR_BYTES;
            expected[start..start + SECTOR_BYTES].fill(value);
        }
        assert_eq!(store.drive(0).unwrap().checkpoint, original);
        store.flush(0).unwrap();
        assert_eq!(store.drive(0).unwrap().checkpoint, expected);
        assert_eq!(store.drive(0).unwrap().checkpoint_copied_bytes, 4 * 512);

        // An identical write still crosses a new durability boundary. The old
        // membership bit must have been cleared so the sector is copied again.
        store.write_sector(0, 7, &[6; SECTOR_BYTES]).unwrap();
        assert!(store.drive(0).unwrap().writes_since_flush);
        store.flush(0).unwrap();
        assert_eq!(store.drive(0).unwrap().checkpoint, expected);
        assert_eq!(store.drive(0).unwrap().checkpoint_copied_bytes, 5 * 512);
        store.flush(0).unwrap();
        assert_eq!(store.drive(0).unwrap().checkpoint_copied_bytes, 5 * 512);
        assert_eq!(store.drive(0).unwrap().flush_count, 3);
        assert!(!store.drive(0).unwrap().writes_since_flush);
    }

    #[test]
    fn checkpoint_tracks_every_sector_when_all_are_written_and_replaced() {
        let mut store = WasmSectorStore::default();
        let sector_count = 33;
        store
            .install(0, &vec![0; sector_count * SECTOR_BYTES], true)
            .unwrap();
        for value in [1, 2] {
            for lba in 0..sector_count as u32 {
                store.write_sector(0, lba, &[value; SECTOR_BYTES]).unwrap();
                store.write_sector(0, lba, &[value; SECTOR_BYTES]).unwrap();
            }
            store.flush(0).unwrap();
            assert_eq!(
                store.drive(0).unwrap().checkpoint,
                vec![value; sector_count * SECTOR_BYTES]
            );
            assert_eq!(
                store.drive(0).unwrap().checkpoint_copied_bytes,
                u64::from(value) * (sector_count * SECTOR_BYTES) as u64
            );
        }
        store.install(0, &[9; SECTOR_BYTES], true).unwrap();
        store.flush(0).unwrap();
        assert_eq!(store.drive(0).unwrap().checkpoint, [9; SECTOR_BYTES]);
        assert_eq!(store.drive(0).unwrap().checkpoint_copied_bytes, 0);
        assert_eq!(store.drive(0).unwrap().flush_count, 1);
    }

    #[test]
    fn eight_mib_checkpoint_tail_and_rejected_writes_preserve_other_sectors() {
        let mut store = WasmSectorStore::default();
        let image_bytes = 8 * 1024 * 1024;
        let sectors = (image_bytes / SECTOR_BYTES) as u32;
        store.install(0, &vec![0; image_bytes], true).unwrap();
        store
            .write_sector(0, sectors - 1, &[7; SECTOR_BYTES])
            .unwrap();
        assert!(store.write_sector(0, sectors, &[9; SECTOR_BYTES]).is_err());
        assert!(store.write_sector(0, u32::MAX, &[9; SECTOR_BYTES]).is_err());
        assert!(store
            .drive(0)
            .unwrap()
            .checkpoint
            .iter()
            .all(|byte| *byte == 0));
        store.flush(0).unwrap();
        let drive = store.drive(0).unwrap();
        assert!(drive.checkpoint[..image_bytes - SECTOR_BYTES]
            .iter()
            .all(|byte| *byte == 0));
        assert_eq!(
            drive.checkpoint[image_bytes - SECTOR_BYTES..],
            [7; SECTOR_BYTES]
        );
        assert_eq!(drive.checkpoint, drive.bytes);
        assert_eq!(drive.checkpoint_copied_bytes, SECTOR_BYTES as u64);
        assert!(!drive.writes_since_flush);
    }

    #[test]
    fn checkpoints_are_initialized_independent_copies_and_per_drive() {
        let mut machine = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        machine.install_drive(0, &[3; SECTOR_BYTES], true).unwrap();
        machine
            .install_drive(255, &[4; SECTOR_BYTES], true)
            .unwrap();
        assert_eq!(
            machine.export_drive_checkpoint(0).unwrap(),
            [3; SECTOR_BYTES]
        );
        assert_eq!(
            machine.export_drive_checkpoint(255).unwrap(),
            [4; SECTOR_BYTES]
        );
        let mut exported = machine.export_drive_checkpoint(0).unwrap();
        exported.fill(9);
        assert_eq!(
            machine.export_drive_checkpoint(0).unwrap(),
            [3; SECTOR_BYTES]
        );

        machine
            .sectors
            .write_sector(0, 0, &[5; SECTOR_BYTES])
            .unwrap();
        machine
            .sectors
            .write_sector(255, 0, &[6; SECTOR_BYTES])
            .unwrap();
        machine.sectors.flush(0).unwrap();
        assert_eq!(
            machine.export_drive_checkpoint(0).unwrap(),
            [5; SECTOR_BYTES]
        );
        assert_eq!(
            machine.export_drive_checkpoint(255).unwrap(),
            [4; SECTOR_BYTES]
        );
        machine.sectors.flush(255).unwrap();
        assert_eq!(
            machine.export_drive_checkpoint(255).unwrap(),
            [6; SECTOR_BYTES]
        );
        assert_eq!(machine.drive_flush_count(0).unwrap(), 1);
        assert_eq!(machine.drive_flush_count(255).unwrap(), 1);

        // Reinstallation is still permitted only before execution and resets all
        // checkpoint bookkeeping together with the backing image.
        machine.install_drive(0, &[7; SECTOR_BYTES], true).unwrap();
        assert_eq!(
            machine.export_drive_checkpoint(0).unwrap(),
            [7; SECTOR_BYTES]
        );
        assert_eq!(machine.drive_flush_count(0).unwrap(), 0);
        assert!(machine.disk_management_ready());
    }

    #[test]
    fn failed_sector_operations_do_not_publish_or_dirty_a_checkpoint() {
        let mut machine = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        machine.install_drive(0, &[1; SECTOR_BYTES], true).unwrap();
        machine.install_drive(1, &[2; SECTOR_BYTES], false).unwrap();
        for lba in [1, 0x7f_ffff, u32::MAX] {
            let mut output = [9; SECTOR_BYTES];
            assert!(machine.sectors.read_sector(0, lba, &mut output).is_err());
            assert_eq!(output, [9; SECTOR_BYTES]);
        }
        assert!(machine
            .sectors
            .write_sector(0, 1, &[3; SECTOR_BYTES])
            .is_err());
        assert!(machine
            .sectors
            .write_sector(1, 0, &[3; SECTOR_BYTES])
            .is_err());
        assert!(machine
            .sectors
            .write_sector(2, 0, &[3; SECTOR_BYTES])
            .is_err());
        assert!(machine.sectors.flush(2).is_err());
        assert!(machine.disk_management_ready());
        for (drive, value) in [(0, 1), (1, 2)] {
            assert_eq!(machine.export_drive(drive).unwrap(), [value; SECTOR_BYTES]);
            assert_eq!(
                machine.export_drive_checkpoint(drive).unwrap(),
                [value; SECTOR_BYTES]
            );
            assert_eq!(machine.drive_flush_count(drive).unwrap(), 0);
        }

        machine
            .sectors
            .write_sector(0, 0, &[4; SECTOR_BYTES])
            .unwrap();
        assert!(machine
            .sectors
            .write_sector(0, 1, &[5; SECTOR_BYTES])
            .is_err());
        assert!(machine.sectors.flush(2).is_err());
        assert!(!machine.disk_management_ready());
        assert_eq!(
            machine.export_drive_checkpoint(0).unwrap(),
            [1; SECTOR_BYTES]
        );
        machine.sectors.flush(0).unwrap();
        assert_eq!(
            machine.export_drive_checkpoint(0).unwrap(),
            [4; SECTOR_BYTES]
        );
        assert!(machine.disk_management_ready());
    }

    #[test]
    fn readiness_requires_every_drive_flushed_even_after_an_identical_write() {
        let mut machine = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        machine.install_drive(0, &[0; SECTOR_BYTES], true).unwrap();
        machine.install_drive(1, &[0; SECTOR_BYTES], true).unwrap();
        assert!(machine.disk_management_ready());
        machine
            .sectors
            .write_sector(0, 0, &[0; SECTOR_BYTES])
            .unwrap();
        machine
            .sectors
            .write_sector(1, 0, &[0; SECTOR_BYTES])
            .unwrap();
        assert!(!machine.disk_management_ready());
        machine.sectors.flush(0).unwrap();
        assert!(!machine.disk_management_ready());
        machine.reset();
        assert!(!machine.disk_management_ready());
        machine.sectors.flush(1).unwrap();
        assert!(machine.disk_management_ready());
    }

    #[test]
    fn readiness_rejects_each_controller_hazard_without_mutating_state() {
        let clean = DiskState {
            drive: 0,
            record: 0,
            error: 0,
            transfer_position: None,
            cache_drive: Some(0),
            cache_sector: Some(0),
            cache_dirty: false,
        };
        assert!(controller_allows_disk_management(clean));
        assert!(!controller_allows_disk_management(DiskState {
            cache_dirty: true,
            ..clean
        }));
        for position in [0, 1, 127] {
            assert!(!controller_allows_disk_management(DiskState {
                transfer_position: Some(position),
                ..clean
            }));
        }
        for error in 1..=u8::MAX {
            assert!(!controller_allows_disk_management(DiskState {
                error,
                ..clean
            }));
        }
        assert!(controller_allows_disk_management(clean));
    }

    #[test]
    fn readiness_rejects_queued_input_until_consumption_or_reset() {
        let mut machine = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        machine.install_drive(0, &[0; SECTOR_BYTES], true).unwrap();
        assert!(machine.enqueue_serial_input(&[65]));
        assert!(!machine.disk_management_ready());
        machine.set_io_trace_enabled(true);
        machine.set_io_trace_enabled(false);
        assert!(!machine.disk_management_ready());
        assert_eq!(machine.console.receive(), Some(65));
        assert!(machine.disk_management_ready());
        assert!(machine.enqueue_serial_input(&[0]));
        assert!(!machine.disk_management_ready());
        machine.reset();
        assert!(machine.disk_management_ready());
    }

    #[test]
    fn serial_input_rejects_a_batch_that_would_exceed_the_queue_limit() {
        let mut machine = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
        assert!(machine.enqueue_serial_input(&vec![1; MAX_SERIAL_INPUT_BYTES]));
        assert_eq!(machine.console.input.len(), MAX_SERIAL_INPUT_BYTES);
        assert!(!machine.enqueue_serial_input(&[2]));
        assert_eq!(machine.console.input.len(), MAX_SERIAL_INPUT_BYTES);
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
