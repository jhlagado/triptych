use std::fs;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use triptych_cpu_core::BOOT_ROM_BYTES;

#[test]
fn flushed_guest_write_survives_a_fresh_native_process() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/conformance/fixtures/cold-boot-disk-persistence.json"
    ))
    .unwrap();
    let temporary = std::env::temp_dir().join(format!(
        "triptych-native-proof-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&temporary).unwrap();
    let first_rom = temporary.join("write.rom");
    let second_rom = temporary.join("read.rom");
    let disk = temporary.join("drive.img");

    fs::write(&first_rom, materialize(&fixture["initial"]["bootRom"])).unwrap();
    fs::write(&disk, materialize(&fixture["initial"]["drives"][0])).unwrap();

    let first = run_host(&first_rom, &disk);
    assert!(first.status.success(), "{:?}", first.stderr);
    assert_eq!(first.stdout, b"BP");
    assert_eq!(fs::read(&disk).unwrap()[128], b'Z');

    let mut read_rom = [0; BOOT_ROM_BYTES];
    let program = [
        0xaf, 0xd3, 0x11, 0x3e, 0x01, 0xd3, 0x12, 0xaf, 0xd3, 0x13, 0xd3, 0x14, 0xd3, 0x15, 0x3e,
        0x01, 0xd3, 0x10, 0xdb, 0x16, 0xd3, 0x00, 0x76,
    ];
    read_rom[..program.len()].copy_from_slice(&program);
    fs::write(&second_rom, read_rom).unwrap();

    let second = run_host(&second_rom, &disk);
    assert!(second.status.success(), "{:?}", second.stderr);
    assert_eq!(second.stdout, b"Z");

    fs::remove_dir_all(&temporary).unwrap();
}

fn run_host(rom: &std::path::Path, disk: &std::path::Path) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_triptych-host-native"))
        .arg(rom)
        .arg(disk)
        .stdin(Stdio::null())
        .output()
        .unwrap()
}

fn materialize(image: &Value) -> Vec<u8> {
    let size = image["size"].as_u64().unwrap() as usize;
    let fill = image["fill"].as_u64().unwrap() as u8;
    let mut bytes = vec![fill; size];
    for patch in image["patches"].as_array().unwrap() {
        let address = patch["address"].as_u64().unwrap() as usize;
        let patch_bytes: Vec<u8> = patch["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|byte| byte.as_u64().unwrap() as u8)
            .collect();
        bytes[address..address + patch_bytes.len()].copy_from_slice(&patch_bytes);
    }
    bytes
}
