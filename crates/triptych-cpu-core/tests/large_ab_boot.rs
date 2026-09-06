//! Real A/B bootstrap and BIOS on the Rust machine with a faulting provider.
//! The CCP area contains an ATOM-built setup probe, not Portable CP/M. This
//! qualifies warm-loader/provider boundaries, not OS, applications or browser IO.

use std::collections::BTreeMap;

use serde::Deserialize;
use sha2::{Digest, Sha256};
use triptych_cpu_core::{
    Console, Devices, DriveInfo, InterruptRequest, IoDirection, IoObserver, IoOperation, Machine,
    MachineMemory, SectorStore, StorageFault, BOOT_ROM_BYTES, RAM_BYTES, SECTOR_BYTES,
};

const IMAGE_BYTES: usize = 8 * 1024 * 1024;
const CCP: usize = 0xe300;
const BIOS: usize = 0xf900;
const RECORDS: [usize; 2] = [256, 260];
const PAYLOADS: [u8; 2] = [0x31, 0x72];
const FIXTURE: &str = include_str!("../../../test/fixtures/large-ab-boot.json");

#[derive(Deserialize)]
struct Fixture {
    format: String,
    artifacts: Vec<Artifact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Artifact {
    id: String,
    source: String,
    source_sha256: String,
    base: usize,
    bytes_sha256: String,
    bytes: Vec<u8>,
    labels: BTreeMap<String, u16>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

impl Fixture {
    fn load() -> Self {
        let fixture: Self = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(fixture.format, "triptych.large-ab-boot-fixture.v1");
        assert_eq!(fixture.artifacts.len(), 3);
        for (id, path, source, base, size) in [
            (
                "bios",
                "system/cpm/bios-8m-ab.asm",
                include_bytes!("../../../system/cpm/bios-8m-ab.asm").as_slice(),
                BIOS,
                Some(1024),
            ),
            (
                "bootstrap",
                "roms/cpu/bootstrap-8m-ab.asm",
                include_bytes!("../../../roms/cpu/bootstrap-8m-ab.asm").as_slice(),
                0,
                Some(BOOT_ROM_BYTES),
            ),
            (
                "setup",
                "test/fixtures/large-ab-boot-setup.asm",
                include_bytes!("../../../test/fixtures/large-ab-boot-setup.asm").as_slice(),
                CCP,
                None,
            ),
        ] {
            let artifact = fixture.artifact(id);
            assert_eq!(artifact.source, path);
            assert_eq!(artifact.source_sha256, digest(source), "stale {id} source");
            assert_eq!(artifact.bytes_sha256, digest(&artifact.bytes));
            assert_eq!(artifact.base, base);
            if let Some(size) = size {
                assert_eq!(artifact.bytes.len(), size);
            } else {
                assert!(artifact.bytes.len() < 256);
            }
        }
        fixture
    }

    fn artifact(&self, id: &str) -> &Artifact {
        let matches: Vec<_> = self.artifacts.iter().filter(|a| a.id == id).collect();
        assert_eq!(matches.len(), 1);
        matches[0]
    }

    fn bios_label(&self, name: &str) -> u16 {
        self.artifact("bios").labels[name]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Fault {
    None,
    CacheWrite,
    Flush(u8),
    Read(u32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Event {
    Read(u8, u32),
    Write(u8, u32),
    Flush(u8),
}

struct Store {
    backing: [Vec<u8>; 2],
    checkpoint: [Vec<u8>; 2],
    fault: Fault,
    events: Vec<Event>,
}

impl SectorStore for Store {
    fn drive_info(&self, drive: u8) -> Option<DriveInfo> {
        self.backing.get(usize::from(drive)).map(|_| DriveInfo {
            sectors: (IMAGE_BYTES / SECTOR_BYTES) as u32,
            writable: true,
        })
    }

    fn read_sector(
        &mut self,
        drive: u8,
        lba: u32,
        output: &mut [u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        self.events.push(Event::Read(drive, lba));
        if drive == 0 && self.fault == Fault::Read(lba) {
            return Err(StorageFault);
        }
        let image = self.backing.get(usize::from(drive)).ok_or(StorageFault)?;
        let start = usize::try_from(lba)
            .ok()
            .and_then(|n| n.checked_mul(SECTOR_BYTES))
            .ok_or(StorageFault)?;
        let sector = image.get(start..).and_then(|s| s.get(..SECTOR_BYTES));
        output.copy_from_slice(sector.ok_or(StorageFault)?);
        Ok(())
    }

    fn write_sector(
        &mut self,
        drive: u8,
        lba: u32,
        input: &[u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        self.events.push(Event::Write(drive, lba));
        if self.fault == Fault::CacheWrite && drive == 1 && lba == 65 {
            return Err(StorageFault);
        }
        let image = self
            .backing
            .get_mut(usize::from(drive))
            .ok_or(StorageFault)?;
        let start = usize::try_from(lba)
            .ok()
            .and_then(|n| n.checked_mul(SECTOR_BYTES))
            .ok_or(StorageFault)?;
        let sector = image
            .get_mut(start..)
            .and_then(|s| s.get_mut(..SECTOR_BYTES));
        sector.ok_or(StorageFault)?.copy_from_slice(input);
        Ok(())
    }

    fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
        self.events.push(Event::Flush(drive));
        if self.fault == Fault::Flush(drive) {
            return Err(StorageFault);
        }
        let index = usize::from(drive);
        let source = self.backing.get(index).ok_or(StorageFault)?;
        self.checkpoint
            .get_mut(index)
            .ok_or(StorageFault)?
            .copy_from_slice(source);
        Ok(())
    }
}

#[derive(Default)]
struct Serial(Vec<u8>);
impl Console for Serial {
    fn receive(&mut self) -> Option<u8> {
        None
    }
    fn transmit(&mut self, byte: u8) {
        self.0.push(byte);
    }
    fn reset(&mut self) {
        self.0.clear();
    }
}

#[derive(Default)]
struct Trace {
    selected: u8,
    commands: Vec<(u8, u8)>,
}
impl IoObserver for Trace {
    fn observe(&mut self, operation: IoOperation) {
        if operation.direction == IoDirection::Write {
            match operation.port & 255 {
                0x11 => self.selected = operation.value,
                0x10 => self.commands.push((self.selected, operation.value)),
                _ => {}
            }
        }
    }
}

struct Rig {
    fixture: Fixture,
    machine: Machine,
    ram: Box<[u8; RAM_BYTES]>,
    rom: [u8; BOOT_ROM_BYTES],
    original: [Vec<u8>; 2],
    store: Store,
    serial: Serial,
    trace: Trace,
}

impl Rig {
    fn prepared(fault: Fault) -> Self {
        let fixture = Fixture::load();
        let mut a = vec![0x39; IMAGE_BYTES];
        for (index, byte) in a[..BIOS - CCP].iter_mut().enumerate() {
            // Distinct records/offsets expose duplicate, skipped or shifted
            // reloads instead of allowing an all-identical resident to pass.
            *byte = ((index / 128 * 17 + index % 128) % 251) as u8;
        }
        let bios = fixture.artifact("bios");
        a[BIOS - CCP..BIOS - CCP + bios.bytes.len()].copy_from_slice(&bios.bytes);
        let setup = fixture.artifact("setup");
        a[..setup.bytes.len()].copy_from_slice(&setup.bytes);
        let original = [a, vec![0x66; IMAGE_BYTES]];
        let rom = fixture
            .artifact("bootstrap")
            .bytes
            .clone()
            .try_into()
            .unwrap();
        let mut rig = Self {
            fixture,
            machine: Machine::new(),
            ram: vec![0xa6; RAM_BYTES].into_boxed_slice().try_into().unwrap(),
            rom,
            store: Store {
                backing: original.clone(),
                checkpoint: original.clone(),
                fault: Fault::None,
                events: Vec::new(),
            },
            original,
            serial: Serial::default(),
            trace: Trace::default(),
        };
        let warm_request = rig.fixture.artifact("setup").labels["WARMREQ"];
        rig.run_until(warm_request);
        assert!(!rig.machine.boot_rom_enabled());
        assert_eq!(rig.ram[4], 1);
        assert_eq!(rig.store.checkpoint, rig.original);
        assert_eq!(rig.store.backing[0], rig.changed(0));
        assert_eq!(rig.store.backing[1], rig.original[1]);
        assert_eq!(rig.machine.disk_state().cache_drive, Some(1));
        assert_eq!(rig.machine.disk_state().cache_sector, Some(65));
        assert!(rig.machine.disk_state().cache_dirty);
        assert!(!rig
            .store
            .events
            .iter()
            .any(|e| matches!(e, Event::Flush(_))));
        // Execute the probe's JP, then its BIOS vector JP before destroying the
        // now-dead synthetic CCP. No CPU registers or controller state injected.
        rig.tick();
        rig.tick();
        assert_eq!(
            rig.machine.cpu_state().pc,
            rig.fixture.bios_label("WARMBOOT")
        );
        rig.ram[CCP..BIOS].fill(0x59);
        rig.ram[0xfc00..].fill(0xa6);
        rig.store.fault = fault;
        rig.store.events.clear();
        rig.trace.commands.clear();
        rig
    }

    fn changed(&self, drive: usize) -> Vec<u8> {
        let mut expected = self.original[drive].clone();
        let start = RECORDS[drive] * 128;
        expected[start..start + 128].fill(PAYLOADS[drive]);
        expected
    }

    fn tick(&mut self) {
        let mut memory = MachineMemory::new(&mut self.ram, &self.rom);
        let mut devices =
            Devices::new(&mut self.serial, &mut self.store).with_observer(&mut self.trace);
        self.machine
            .step(&mut memory, &mut devices, InterruptRequest::None);
    }

    fn run_until(&mut self, pc: u16) {
        for _ in 0..100_000 {
            if self.machine.cpu_state().pc == pc {
                return;
            }
            assert!(
                !self.machine.cpu_state().halted,
                "unexpected halt before {pc:04x}"
            );
            self.tick();
        }
        panic!("step limit before {pc:04x}");
    }

    fn warm(&mut self, succeeds: bool) {
        let mut minimum_sp = u16::MAX;
        for _ in 0..100_000 {
            let state = self.machine.cpu_state();
            if state.pc == CCP as u16 || state.halted {
                assert_eq!(state.pc == CCP as u16, succeeds);
                assert_eq!(state.halted, !succeeds);
                assert!(minimum_sp >= self.fixture.bios_label("BOOTSP") - 32);
                assert_eq!(&self.ram[0xfc00..], &[0xa6; 1024]);
                if succeeds {
                    assert_eq!(state.c, 1);
                    assert_eq!(state.sp, self.fixture.bios_label("BOOTSP"));
                    assert_eq!(&self.ram[5..8], &[0xc3, 6, 0xeb]);
                    assert!(self.serial.0.is_empty());
                } else {
                    assert_eq!(self.serial.0, b"CP/M BOOT ERROR\r\n");
                }
                return;
            }
            self.tick();
            minimum_sp = minimum_sp.min(self.machine.cpu_state().sp);
        }
        panic!("warm boot exceeded step limit");
    }

    fn no_reload(&self) {
        assert_eq!(&self.ram[CCP..BIOS], &[0x59; BIOS - CCP]);
        assert!(!self.trace.commands.iter().any(|(_, command)| *command == 1));
        assert!(!self
            .store
            .events
            .iter()
            .any(|e| matches!(e, Event::Read(_, _))));
    }
}

#[test]
fn actual_bios_checkpoints_both_dirty_drives_before_reload() {
    let mut rig = Rig::prepared(Fault::None);
    rig.warm(true);
    assert_eq!(rig.store.backing, [rig.changed(0), rig.changed(1)]);
    assert_eq!(rig.store.checkpoint, rig.store.backing);
    assert!(!rig.machine.disk_state().cache_dirty);
    assert_eq!(
        &rig.store.events[..3],
        &[Event::Write(1, 65), Event::Flush(0), Event::Flush(1)]
    );
    assert_eq!(&rig.trace.commands[..3], &[(0, 4), (0, 3), (1, 3)]);
    assert_eq!(rig.trace.commands[3..], vec![(0, 1); 44]);
    assert_eq!(&rig.ram[CCP..BIOS], &rig.original[0][..BIOS - CCP]);
}

#[test]
fn cache_write_failure_keeps_dirty_cache_and_both_prior_checkpoints() {
    let mut rig = Rig::prepared(Fault::CacheWrite);
    rig.warm(false);
    rig.no_reload();
    assert_eq!(rig.store.events, [Event::Write(1, 65)]);
    assert_eq!(rig.trace.commands, [(0, 4), (0, 3)]);
    assert_eq!(rig.store.checkpoint, rig.original);
    assert_eq!(rig.store.backing, [rig.changed(0), rig.original[1].clone()]);
    assert!(rig.machine.disk_state().cache_dirty);
    assert_eq!(rig.machine.disk_state().cache_drive, Some(1));
    // A machine reset retains the controller cache. Removing the injected fault
    // lets the real cold loader evict it on its first A read, proving the pending
    // bytes survived, not merely that a dirty flag remained set. Stop before the
    // setup probe runs again; neither provider checkpoint has been republished.
    rig.store.fault = Fault::None;
    {
        let mut devices = Devices::new(&mut rig.serial, &mut rig.store);
        rig.machine.reset(&mut devices);
    }
    rig.run_until(CCP as u16);
    assert_eq!(rig.store.backing, [rig.changed(0), rig.changed(1)]);
    assert_eq!(rig.store.checkpoint, rig.original);
    assert!(!rig.machine.disk_state().cache_dirty);
}

#[test]
fn first_provider_flush_failure_does_not_publish_either_checkpoint() {
    let mut rig = Rig::prepared(Fault::Flush(0));
    rig.warm(false);
    rig.no_reload();
    assert_eq!(rig.store.events, [Event::Write(1, 65), Event::Flush(0)]);
    assert_eq!(rig.trace.commands, [(0, 4), (0, 3)]);
    assert_eq!(rig.store.checkpoint, rig.original);
    assert_eq!(rig.store.backing, [rig.changed(0), rig.changed(1)]);
    assert!(!rig.machine.disk_state().cache_dirty);
}

#[test]
fn second_provider_flush_failure_retains_the_first_successful_checkpoint() {
    let mut rig = Rig::prepared(Fault::Flush(1));
    rig.warm(false);
    rig.no_reload();
    assert_eq!(
        rig.store.events,
        [Event::Write(1, 65), Event::Flush(0), Event::Flush(1)]
    );
    assert_eq!(rig.trace.commands, [(0, 4), (0, 3), (1, 3)]);
    assert_eq!(
        rig.store.checkpoint,
        [rig.changed(0), rig.original[1].clone()]
    );
    assert_eq!(rig.store.backing, [rig.changed(0), rig.changed(1)]);
    assert!(!rig.machine.disk_state().cache_dirty);
}

#[test]
fn warm_read_failures_stop_at_exact_partial_reload_without_rolling_back_flushes() {
    for sector in [0, 1] {
        let mut rig = Rig::prepared(Fault::Read(sector));
        rig.warm(false);
        assert_eq!(rig.store.checkpoint, [rig.changed(0), rig.changed(1)]);
        assert_eq!(rig.store.backing, rig.store.checkpoint);
        let loaded = sector as usize * SECTOR_BYTES;
        assert_eq!(&rig.ram[CCP..CCP + loaded], &rig.original[0][..loaded]);
        assert!(rig.ram[CCP + loaded..BIOS].iter().all(|b| *b == 0x59));
        let mut expected = vec![Event::Write(1, 65), Event::Flush(0), Event::Flush(1)];
        expected.extend((0..=sector).map(|lba| Event::Read(0, lba)));
        assert_eq!(rig.store.events, expected);
        assert_eq!(&rig.trace.commands[..3], &[(0, 4), (0, 3), (1, 3)]);
        assert_eq!(rig.trace.commands[3..], vec![(0, 1); loaded / 128 + 1]);
    }
}
