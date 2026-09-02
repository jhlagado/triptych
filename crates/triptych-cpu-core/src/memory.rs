use crate::{BOOT_ROM_BYTES, RAM_BYTES};

pub struct MachineMemory<'a> {
    pub(crate) ram: &'a mut [u8; RAM_BYTES],
    pub(crate) boot_rom: &'a [u8; BOOT_ROM_BYTES],
}

impl<'a> MachineMemory<'a> {
    pub fn new(ram: &'a mut [u8; RAM_BYTES], boot_rom: &'a [u8; BOOT_ROM_BYTES]) -> Self {
        Self { ram, boot_rom }
    }

    pub fn ram(&self) -> &[u8; RAM_BYTES] {
        self.ram
    }

    pub fn ram_mut(&mut self) -> &mut [u8; RAM_BYTES] {
        self.ram
    }

    pub fn boot_rom(&self) -> &[u8; BOOT_ROM_BYTES] {
        self.boot_rom
    }
}
