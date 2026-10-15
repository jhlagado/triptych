use std::fs;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;

/// The cold-boot fixture writes record 1, flushes and prints `BP`. Timing must
/// not change what the guest does, in either mode, and must report the I/O.
#[test]
fn disk_timing_reports_without_changing_guest_behaviour() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/conformance/fixtures/cold-boot-disk-persistence.json"
    ))
    .unwrap();
    let temporary = std::env::temp_dir().join(format!(
        "triptych-native-timing-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir(&temporary).unwrap();
    let rom = temporary.join("write.rom");
    let disk = temporary.join("drive.img");
    fs::write(&rom, materialize(&fixture["initial"]["bootRom"])).unwrap();

    for (profile, mode) in [
        ("8in-sssd", "account"),
        ("8in-sssd", "stall"),
        ("5in-dsdd", "account"),
        ("5in-dsdd", "stall"),
    ] {
        fs::write(&disk, materialize(&fixture["initial"]["drives"][0])).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_triptych-host-native"))
            .args(["--disk-timing", profile, "--disk-timing-mode", mode])
            .arg(&rom)
            .arg(&disk)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        let report = String::from_utf8(output.stderr).unwrap();
        assert!(output.status.success(), "{report}");
        assert_eq!(output.stdout, b"BP", "{profile} {mode}");
        assert_eq!(fs::read(&disk).unwrap()[128], b'Z');
        assert!(
            report.contains(&format!("disk timing: {profile} at 4.000 MHz, {mode}")),
            "{report}"
        );
        assert!(report.contains("1 writes"), "{report}");
    }

    let output = Command::new(env!("CARGO_BIN_EXE_triptych-host-native"))
        .args(["--disk-timing-mode", "stall"])
        .arg(&rom)
        .arg(&disk)
        .stdin(Stdio::null())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("require --disk-timing"));

    fs::remove_dir_all(&temporary).unwrap();
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
