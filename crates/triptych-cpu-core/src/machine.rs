use crate::engine::{Adapter, EngineBus};
use crate::ports;
use crate::{disk::Controller, serial::Serial};
use crate::{
    CpuState, Devices, DiskState, InterruptRequest, IoDirection, IoOperation, MachineMemory,
    RunBudget, RunExit, RunReason, StepResult,
};

#[derive(Default)]
pub struct Machine {
    engine: Adapter,
    boot_rom_enabled: bool,
    serial: Serial,
    disk: Controller,
}

impl Machine {
    pub fn new() -> Self {
        let mut machine = Self {
            engine: Adapter::new(),
            boot_rom_enabled: true,
            serial: Serial::default(),
            disk: Controller::default(),
        };
        machine.engine.reset();
        machine
    }

    pub fn reset(&mut self, devices: &mut Devices<'_>) {
        self.engine.reset();
        self.boot_rom_enabled = true;
        self.serial.reset();
        self.disk.reset();
        devices.reset_external_devices();
    }

    pub fn step(
        &mut self,
        memory: &mut MachineMemory<'_>,
        devices: &mut Devices<'_>,
        interrupt: InterruptRequest,
    ) -> StepResult {
        let mut bus = MachineBus {
            memory,
            devices,
            boot_rom_enabled: &mut self.boot_rom_enabled,
            serial: &mut self.serial,
            disk: &mut self.disk,
            tstates: 0,
        };
        self.engine.step(&mut bus);
        let interrupt_accepted = match interrupt {
            InterruptRequest::None => false,
            InterruptRequest::MaskableFf => self.engine.interrupt_maskable_ff(&mut bus),
        };
        StepResult {
            tstates: bus.tstates,
            halted: self.engine.halted(),
            interrupt_accepted,
        }
    }

    pub fn run_slice(
        &mut self,
        memory: &mut MachineMemory<'_>,
        devices: &mut Devices<'_>,
        budget: RunBudget,
    ) -> RunExit {
        if self.engine.halted() {
            return RunExit {
                reason: RunReason::Halted,
                steps: 0,
                tstates: 0,
            };
        }

        let mut steps = 0;
        let mut tstates = 0;
        loop {
            let result = self.step(memory, devices, InterruptRequest::None);
            steps += 1;
            tstates += u64::from(result.tstates);
            if result.halted {
                return RunExit {
                    reason: RunReason::Halted,
                    steps,
                    tstates,
                };
            }
            if steps >= budget.max_steps.get() {
                return RunExit {
                    reason: RunReason::StepLimit,
                    steps,
                    tstates,
                };
            }
            if tstates >= budget.max_tstates.get() {
                return RunExit {
                    reason: RunReason::TStateLimit,
                    steps,
                    tstates,
                };
            }
        }
    }

    pub fn cpu_state(&self) -> CpuState {
        self.engine.state()
    }

    pub fn boot_rom_enabled(&self) -> bool {
        self.boot_rom_enabled
    }

    pub fn disk_state(&self) -> DiskState {
        self.disk.state()
    }

    /// Install architectural fields immediately before a conformance reset.
    /// Private engine latches are deliberately not part of this test boundary.
    #[cfg(feature = "conformance")]
    pub fn install_conformance_cpu_state(&mut self, state: CpuState) {
        self.engine.install_architectural_state(state);
    }
}

struct MachineBus<'a, 'mem, 'dev> {
    memory: &'a mut MachineMemory<'mem>,
    devices: &'a mut Devices<'dev>,
    boot_rom_enabled: &'a mut bool,
    serial: &'a mut Serial,
    disk: &'a mut Controller,
    tstates: u32,
}

impl EngineBus for MachineBus<'_, '_, '_> {
    fn read(&mut self, address: u16) -> u8 {
        let index = usize::from(address);
        if *self.boot_rom_enabled && index < crate::BOOT_ROM_BYTES {
            self.memory.boot_rom[index]
        } else {
            self.memory.ram[index]
        }
    }

    fn write(&mut self, address: u16, value: u8) {
        self.memory.ram[usize::from(address)] = value;
    }

    fn input(&mut self, port: u16) -> u8 {
        let low = port as u8;
        let value = match low {
            ports::SERIAL_DATA => self.serial.read_data(self.devices.console),
            ports::SERIAL_STATUS => self.serial.read_status(self.devices.console),
            ports::DISK_FIRST..=ports::DISK_LAST => self.disk.read_port(low, self.devices.sectors),
            ports::SYSTEM_CONTROL => u8::from(*self.boot_rom_enabled),
            ports::VIDEO_FIRST..=ports::VIDEO_LAST => self
                .devices
                .video
                .as_deref_mut()
                .map_or(0, |video| video.read(low - ports::VIDEO_FIRST)),
            ports::SOUND_FIRST..=ports::SOUND_LAST => self
                .devices
                .sound
                .as_deref_mut()
                .map_or(0, |sound| sound.read(low - ports::SOUND_FIRST)),
            _ => 0,
        };
        self.devices.observe(IoOperation {
            direction: IoDirection::Read,
            port,
            value,
        });
        value
    }

    fn output(&mut self, port: u16, value: u8) {
        self.devices.observe(IoOperation {
            direction: IoDirection::Write,
            port,
            value,
        });
        let low = port as u8;
        match low {
            ports::SERIAL_DATA => self.devices.console.transmit(value),
            ports::DISK_FIRST..=ports::DISK_LAST => {
                self.disk.write_port(low, value, self.devices.sectors);
            }
            ports::SYSTEM_CONTROL if value == ports::BOOT_ROM_DISABLE_KEY => {
                *self.boot_rom_enabled = false;
            }
            ports::VIDEO_FIRST..=ports::VIDEO_LAST => {
                if let Some(video) = self.devices.video.as_deref_mut() {
                    video.write(low - ports::VIDEO_FIRST, value);
                }
            }
            ports::SOUND_FIRST..=ports::SOUND_LAST => {
                if let Some(sound) = self.devices.sound.as_deref_mut() {
                    sound.write(low - ports::SOUND_FIRST, value);
                }
            }
            _ => {}
        }
    }

    fn tick(&mut self, tstates: u32) {
        self.tstates = self
            .tstates
            .checked_add(tstates)
            .expect("one Z80 instruction exceeded u32 T-states");
    }
}
