#![no_std]

//! Portable, deterministic implementation of the Triptych CPU v0.1 machine.

mod disk;
mod engine;
mod host;
mod machine;
mod memory;
mod ports;
mod serial;
mod state;

pub use disk::DiskState;
pub use host::{
    Console, Devices, DriveInfo, IoDirection, IoObserver, IoOperation, PortTransport, SectorStore,
    StorageFault,
};
pub use machine::Machine;
pub use memory::MachineMemory;
pub use state::{CpuFlags, CpuState, InterruptRequest, RunBudget, RunExit, RunReason, StepResult};

pub const RAM_BYTES: usize = 65_536;
pub const BOOT_ROM_BYTES: usize = 256;
pub const SECTOR_BYTES: usize = 512;
pub const RECORD_BYTES: usize = 128;
