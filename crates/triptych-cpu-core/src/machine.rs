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

    /// Prepare a synchronous host media replacement without resetting the CPU.
    ///
    /// Returns false without changing any state when a disk transfer is active
    /// or the controller cache is dirty. Success invalidates the clean cache,
    /// preventing a replacement at the same drive/sector from reading old bytes.
    /// Selection, error, CPU, RAM, boot overlay and console state are preserved.
    ///
    /// The host must suspend execution, call this immediately before replacing
    /// the backing media, and finish replacement before resuming execution.
    /// This allocation-free guard neither flushes provider storage nor proves
    /// guest filesystem readiness, closed files, or durable host checkpoints.
    /// Hosts must establish those conditions and reset guest disk login state
    /// through the guest's supported protocol separately.
    pub fn prepare_media_change(&mut self) -> bool {
        self.disk.prepare_media_change()
    }

    /// Whether serial input has been prefetched into the controller but has not
    /// been consumed by a guest data read. Does not poll or consume host input;
    /// hosts must inspect their own input queue separately.
    pub fn console_input_pending(&self) -> bool {
        self.serial.input_pending()
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Console;

    struct Input(Option<u8>);

    impl Console for Input {
        fn receive(&mut self) -> Option<u8> {
            self.0.take()
        }

        fn transmit(&mut self, _: u8) {}

        fn reset(&mut self) {
            self.0 = None;
        }
    }

    #[test]
    #[cfg(feature = "conformance")]
    fn media_change_preserves_live_cpu_memory_overlay_and_pending_input() {
        let mut machine = Machine::new();
        let state = CpuState {
            a: 0x42,
            pc: 0x1234,
            sp: 0xabcd,
            ix: 0x9876,
            iff1: true,
            ..CpuState::default()
        };
        machine.install_conformance_cpu_state(state);
        machine.boot_rom_enabled = false;
        let mut ram = [0x5a; crate::RAM_BYTES];
        let boot = [0; crate::BOOT_ROM_BYTES];
        let memory = MachineMemory::new(&mut ram, &boot);
        let mut console = Input(Some(65));
        assert_eq!(machine.serial.read_status(&mut console), 3);
        let before = machine.cpu_state();
        assert!(machine.prepare_media_change());
        assert_eq!(machine.cpu_state(), before);
        assert!(!machine.boot_rom_enabled());
        assert!(memory.ram().iter().all(|byte| *byte == 0x5a));
        assert!(machine.console_input_pending());
        assert_eq!(machine.serial.read_data(&mut console), 65);
    }

    #[test]
    fn pending_console_diagnostic_observes_without_consuming_prefetched_input() {
        let mut machine = Machine::new();
        let mut console = Input(Some(65));
        assert!(!machine.console_input_pending());
        assert_eq!(console.0, Some(65));
        assert_eq!(machine.serial.read_status(&mut console), 3);
        assert_eq!(console.0, None);
        assert!(machine.console_input_pending());
        assert!(machine.console_input_pending());
        assert_eq!(machine.serial.read_data(&mut console), 65);
        assert!(!machine.console_input_pending());
        console.0 = Some(0);
        assert_eq!(machine.serial.read_status(&mut console), 3);
        assert!(machine.console_input_pending());
        machine.serial.reset();
        assert!(!machine.console_input_pending());
    }
}
