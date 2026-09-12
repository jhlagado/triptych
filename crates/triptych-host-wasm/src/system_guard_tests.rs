use super::*;

const BIOS: u32 = 0xfa00;
const WARM: u16 = 0xfa40;
const PREFIX_BYTES: usize = 52 * 128;

fn prefix() -> Vec<u8> {
    let mut bytes = vec![0; PREFIX_BYTES];
    for entry in 0..17 {
        let target = if entry == 1 { WARM } else { BIOS as u16 + 51 };
        bytes[0x1600 + entry * 3..0x1603 + entry * 3].copy_from_slice(&[
            0xc3,
            target as u8,
            (target >> 8) as u8,
        ]);
    }
    for offset in [0x1633, 0x1640] {
        bytes[offset..offset + 4].copy_from_slice(&[0xf3, 0x31, 0x00, 0xe3]);
    }
    bytes
}

fn setup() -> (TriptychCpu, Vec<u8>) {
    let mut rom = [0; BOOT_ROM_BYTES];
    // Tiny CPU test boot: disable overlay and jump into the RAM test program.
    rom[..7].copy_from_slice(&[0x3e, 0xa5, 0xd3, 0x20, 0xc3, 0x00, 0x01]);
    let mut cpu = TriptychCpu::new(&rom).unwrap();
    let source = prefix();
    cpu.install_drive(0, &source, true).unwrap();
    cpu.write_ram(0, &rom).unwrap();
    cpu.write_ram(BIOS, &source[0x1600..]).unwrap();
    assert!(cpu.configure_system_guard(&source, BIOS));
    for _ in 0..3 {
        assert!(cpu.step(false) > 0);
    }
    assert_eq!(cpu.machine.cpu_state().pc, 0x100);
    (cpu, source)
}

fn jump(cpu: &mut TriptychCpu, target: u16) {
    cpu.write_ram(0x100, &[0xc3, target as u8, (target >> 8) as u8])
        .unwrap();
}

#[test]
fn system_guard_rejects_missing_mismatched_and_malformed_admission() {
    let source = prefix();
    let mut cpu = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
    assert!(!cpu.configure_system_guard(&source, BIOS));
    cpu.install_drive(0, &source, false).unwrap();
    for invalid in [&source[..PREFIX_BYTES - 1], &source[..512], &[]] {
        assert!(!cpu.configure_system_guard(invalid, BIOS));
    }
    for invalid in [0, BIOS + 1, 0xff00, u32::MAX] {
        assert!(!cpu.configure_system_guard(&source, invalid));
    }
    let mut changed = source.clone();
    changed[0] = 1;
    assert!(!cpu.configure_system_guard(&changed, BIOS));
    for offset in [0x1600, 0x1603, 0x1640, 0x1641] {
        let mut bad = source.clone();
        bad[offset] = 0;
        cpu.install_drive(0, &bad, false).unwrap();
        assert!(!cpu.configure_system_guard(&bad, BIOS));
    }
    cpu.install_drive(0, &source, false).unwrap();
    assert!(cpu.configure_system_guard(&source, BIOS));
    assert!(!cpu.configure_system_guard(&source, BIOS));
}

#[test]
fn system_guard_stops_all_warm_entries_before_instruction_and_restores_without_reset() {
    for entry in [0, BIOS as u16 + 3, WARM] {
        for missing in [false, true] {
            let (mut cpu, source) = setup();
            jump(&mut cpu, entry);
            let ticket = if missing {
                cpu.prepare_drive_eject(0)
            } else {
                cpu.prepare_drive_change(0, &vec![0; PREFIX_BYTES], false)
            };
            assert_ne!(ticket, 0);
            assert!(cpu.commit_media_change(ticket));
            assert!(!cpu.system_disk_matches());
            cpu.set_io_trace_enabled(true);
            assert_eq!(cpu.run_slice(100, 1000).unwrap(), 4);
            assert_eq!(cpu.machine.cpu_state().pc, entry);
            assert_eq!(cpu.system_recovery_pending(), 1);
            assert_eq!(cpu.last_steps(), 1);
            let state = cpu.machine.cpu_state();
            let ram = cpu.ram_image();
            let controller = cpu.machine.disk_state();
            let counters = (cpu.last_steps(), cpu.last_tstates());
            for _ in 0..3 {
                assert_eq!(cpu.step(true), 0);
                assert_eq!(cpu.run_slice(100, 1000).unwrap(), 4);
                assert!(!cpu.enqueue_serial_input(&[65]));
                assert!(!cpu.complete_system_disk_restore());
                assert_eq!(cpu.machine.cpu_state(), state);
                assert_eq!(cpu.ram_image(), ram);
                assert_eq!(cpu.machine.disk_state(), controller);
                assert_eq!((cpu.last_steps(), cpu.last_tstates()), counters);
                assert!(cpu.take_io_trace().is_empty());
            }
            let ticket = cpu.prepare_drive_change(0, &source, true);
            assert_ne!(ticket, 0);
            assert!(!cpu.complete_system_disk_restore());
            assert!(cpu.commit_media_change(ticket));
            assert_eq!(
                cpu.system_recovery_pending(),
                1,
                "install alone cannot clear recovery"
            );
            assert!(cpu.complete_system_disk_restore());
            assert_eq!(cpu.system_recovery_pending(), 0);
            assert_eq!(cpu.machine.cpu_state(), state);
            assert_eq!(cpu.ram_image(), ram);
            assert!(cpu.step(false) > 0);
        }
    }
}

#[test]
fn system_guard_reset_is_deferred_until_explicit_verified_restore() {
    let (mut cpu, source) = setup();
    let ticket = cpu.prepare_drive_eject(0);
    assert!(cpu.commit_media_change(ticket));
    let state = cpu.machine.cpu_state();
    let ram = cpu.ram_image();
    let counters = (cpu.last_steps(), cpu.last_tstates());
    cpu.reset();
    assert_eq!(cpu.system_recovery_pending(), 2);
    cpu.reset();
    assert_eq!(cpu.step(false), 0);
    assert_eq!(cpu.run_slice(100, 1000).unwrap(), 4);
    assert_eq!(cpu.machine.cpu_state(), state);
    assert_eq!(cpu.ram_image(), ram);
    assert_eq!((cpu.last_steps(), cpu.last_tstates()), counters);
    let ticket = cpu.prepare_drive_change(0, &source, false);
    assert!(cpu.commit_media_change(ticket));
    assert_eq!(cpu.machine.cpu_state(), state);
    assert!(cpu.complete_system_disk_restore());
    assert_eq!(cpu.machine.cpu_state().pc, 0);
    assert!(cpu.boot_rom_enabled());
    assert_eq!(cpu.ram_image(), ram);
    assert_eq!(cpu.last_steps(), 0);
}

#[test]
fn system_guard_matching_prefix_wrong_length_and_changed_writable_system_are_not_admitted() {
    let (mut cpu, source) = setup();
    jump(&mut cpu, WARM);
    let mut wrong = source.clone();
    wrong.extend_from_slice(&[0; SECTOR_BYTES]);
    let ticket = cpu.prepare_drive_change(0, &wrong, true);
    assert!(cpu.commit_media_change(ticket));
    assert!(!cpu.system_disk_matches());
    assert_eq!(cpu.run_slice(100, 1000).unwrap(), 4);
    assert!(!cpu.complete_system_disk_restore());
    let ticket = cpu.prepare_drive_change(0, &source, true);
    assert!(cpu.commit_media_change(ticket));
    cpu.sectors.write_sector(0, 0, &[9; SECTOR_BYTES]).unwrap();
    assert!(!cpu.system_disk_matches());
    assert!(!cpu.complete_system_disk_restore());
    assert_eq!(cpu.system_recovery_pending(), 1);
}

#[test]
fn system_guard_keeps_data_execution_live_and_preserves_trace_at_recovery() {
    let (mut cpu, source) = setup();
    // LD A,42; OUT serial; NOP; JP WarmBoot. All instruction bytes are
    // explicit core-test vectors, not a substitute guest assembly artifact.
    cpu.write_ram(
        0x100,
        &[0x3e, 42, 0xd3, 0, 0, 0xc3, WARM as u8, (WARM >> 8) as u8],
    )
    .unwrap();
    cpu.set_io_trace_enabled(true);
    let ticket = cpu.prepare_drive_change(0, &vec![1; PREFIX_BYTES], false);
    assert!(cpu.commit_media_change(ticket));
    assert_eq!(cpu.run_slice(2, 1000).unwrap(), RUN_STEP_LIMIT);
    assert_eq!(cpu.last_steps(), 2);
    assert_eq!(cpu.system_recovery_pending(), 0);
    assert_eq!(cpu.serial_output(), [42]);
    assert_eq!(cpu.run_slice(100, 1000).unwrap(), RUN_SYSTEM_RECOVERY);
    assert_eq!(cpu.last_steps(), 2);
    let trace = cpu.observer.operations.clone();
    assert_eq!(trace.len(), 1);
    cpu.set_io_trace_enabled(false);
    assert!(cpu.take_io_trace().is_empty());
    assert_eq!(cpu.observer.operations, trace);
    assert!(cpu.observer.enabled);
    assert!(cpu.take_serial_output().is_empty());
    assert_eq!(cpu.serial_output(), [42]);
    let ticket = cpu.prepare_drive_change(0, &source, false);
    assert!(cpu.commit_media_change(ticket));
    assert!(cpu.complete_system_disk_restore());
    assert_eq!(cpu.take_serial_output(), [42]);
    assert_eq!(
        cpu.take_io_trace(),
        trace.into_iter().map(pack_io).collect::<Vec<_>>()
    );
}

#[test]
fn system_guard_owns_prefix_and_preserves_slice_limits_and_halt_behaviour() {
    let (mut cpu, mut source) = setup();
    source.fill(99);
    assert!(
        cpu.system_disk_matches(),
        "caller mutation cannot change guard authority"
    );
    cpu.write_ram(0x100, &[0, 0, 0x76]).unwrap();
    assert_eq!(cpu.run_slice(100, 4).unwrap(), RUN_TSTATE_LIMIT);
    assert_eq!((cpu.last_steps(), cpu.last_tstates()), (1, 4));
    assert_eq!(cpu.run_slice(100, 1000).unwrap(), RUN_HALTED);
    assert_eq!(cpu.last_steps(), 2);
    assert!(cpu.last_halted());
    assert_eq!(cpu.run_slice(100, 1000).unwrap(), RUN_HALTED);
    assert_eq!((cpu.last_steps(), cpu.last_tstates()), (0, 0));
    assert_eq!(cpu.system_recovery_pending(), 0);
    assert!(!cpu.configure_system_guard(&prefix(), BIOS));
    assert!(
        !cpu.complete_system_disk_restore(),
        "no pending request to acknowledge"
    );
}

#[test]
fn system_guard_rejects_admission_after_execution_and_protects_preboot_replacement() {
    let source = prefix();
    let mut cpu = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
    cpu.install_drive(0, &source, false).unwrap();
    cpu.step(false);
    assert!(!cpu.configure_system_guard(&source, BIOS));
    let mut cpu = TriptychCpu::new(&[0; BOOT_ROM_BYTES]).unwrap();
    cpu.install_drive(0, &source, false).unwrap();
    assert!(cpu.configure_system_guard(&source, BIOS));
    cpu.install_drive(0, &vec![1; PREFIX_BYTES], false).unwrap();
    let state = cpu.machine.cpu_state();
    assert_eq!(cpu.step(false), 0);
    assert_eq!(cpu.system_recovery_pending(), 2);
    assert_eq!(cpu.machine.cpu_state(), state);
}
