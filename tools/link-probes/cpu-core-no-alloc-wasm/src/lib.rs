#![no_std]

use core::alloc::{GlobalAlloc, Layout};
use core::panic::PanicInfo;

use triptych_cpu_core::{
    Console, Devices, DriveInfo, InterruptRequest, Machine, MachineMemory,
    SectorStore, StorageFault, BOOT_ROM_BYTES, RAM_BYTES, SECTOR_BYTES,
};

struct NullHost;

struct RejectAllocation;

unsafe impl GlobalAlloc for RejectAllocation {
    unsafe fn alloc(&self, _layout: Layout) -> *mut u8 {
        core::arch::wasm32::unreachable()
    }

    unsafe fn dealloc(&self, _pointer: *mut u8, _layout: Layout) {
        core::arch::wasm32::unreachable()
    }
}

#[global_allocator]
static ALLOCATOR: RejectAllocation = RejectAllocation;

impl Console for NullHost {
    fn receive(&mut self) -> Option<u8> {
        None
    }

    fn transmit(&mut self, _byte: u8) {}

    fn reset(&mut self) {}
}

impl SectorStore for NullHost {
    fn drive_info(&self, _drive: u8) -> Option<DriveInfo> {
        None
    }

    fn read_sector(
        &mut self,
        _drive: u8,
        _lba: u32,
        _output: &mut [u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        Err(StorageFault)
    }

    fn write_sector(
        &mut self,
        _drive: u8,
        _lba: u32,
        _input: &[u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        Err(StorageFault)
    }

    fn flush(&mut self, _drive: u8) -> Result<(), StorageFault> {
        Err(StorageFault)
    }
}

#[no_mangle]
pub extern "C" fn triptych_cpu_core_link_probe() -> u32 {
    let mut ram = [0; RAM_BYTES];
    let mut rom = [0; BOOT_ROM_BYTES];
    rom[0] = 0x76;
    let mut host = NullHost;
    let mut sectors = NullHost;
    let mut machine = Machine::new();
    let result = {
        let mut memory = MachineMemory::new(&mut ram, &rom);
        let mut devices = Devices::new(&mut host, &mut sectors);
        machine.step(&mut memory, &mut devices, InterruptRequest::None)
    };
    result.tstates
}

#[panic_handler]
fn panic(_information: &PanicInfo<'_>) -> ! {
    loop {}
}
