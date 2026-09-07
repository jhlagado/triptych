#![cfg(unix)]

use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Fixture {
    directory: PathBuf,
    rom: PathBuf,
    a: PathBuf,
    p: PathBuf,
}
impl Fixture {
    fn new(program: &[u8]) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "triptych-sparse-cli-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let rom = directory.join("boot.rom");
        let a = directory.join("a.img");
        let p = directory.join("p.img");
        let mut bytes = [0; 256];
        bytes[..program.len()].copy_from_slice(program);
        fs::write(&rom, bytes).unwrap();
        fs::write(&a, [b'A'; 512]).unwrap();
        fs::write(&p, [b'P'; 512]).unwrap();
        Self {
            directory,
            rom,
            a,
            p,
        }
    }
    fn run(&self, arguments: &[&OsStr]) -> Output {
        Command::new(env!("CARGO_BIN_EXE_triptych-host-native"))
            .args(arguments)
            .stdin(Stdio::null())
            .output()
            .unwrap()
    }
    fn unchanged(&self) {
        assert_eq!(fs::read(&self.a).unwrap(), [b'A'; 512]);
        assert_eq!(fs::read(&self.p).unwrap(), [b'P'; 512]);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn word(value: &str) -> &OsStr {
    OsStr::new(value)
}
fn path(value: &Path) -> &OsStr {
    value.as_os_str()
}

#[test]
fn explicit_sparse_mapping_reads_p_reports_missing_b_then_reads_a() {
    // Controller-conformance byte fixture: zero the record address; select P,
    // READ/output first byte; select missing B, READ/output error; select A,
    // READ/output first byte; HALT. No CP/M geometry/profile is assumed.
    let fixture = Fixture::new(&[
        0xaf, 0xd3, 0x12, 0xd3, 0x13, 0xd3, 0x14, 0xd3, 0x15, 0x3e, 15, 0xd3, 0x11, 0x3e, 1, 0xd3,
        0x10, 0xdb, 0x16, 0xd3, 0, 0x3e, 1, 0xd3, 0x11, 0x3e, 1, 0xd3, 0x10, 0xdb, 0x17, 0xd3, 0,
        0xaf, 0xd3, 0x11, 0x3e, 1, 0xd3, 0x10, 0xdb, 0x16, 0xd3, 0, 0x76,
    ]);
    let output = fixture.run(&[
        word("--slots"),
        word("16"),
        word("--drive"),
        word("P"),
        path(&fixture.p),
        word("--drive"),
        word("A"),
        path(&fixture.a),
        word("--image-bytes"),
        word("512"),
        path(&fixture.rom),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"P\x01A");
    fixture.unchanged();
}

#[test]
fn legacy_positional_mapping_and_scripted_options_still_work() {
    // IN A,(console); OUT (console),A; HALT.
    let fixture = Fixture::new(&[0xdb, 0, 0xd3, 0, 0x76]);
    for explicit in [false, true] {
        let mut arguments = vec![
            word("--input-ascii"),
            word("X"),
            word("--stop-after"),
            word("X"),
            word("--max-steps"),
            word("50000"),
            path(&fixture.rom),
        ];
        if explicit {
            arguments.extend([
                word("--slots"),
                word("2"),
                word("--drive"),
                word("A"),
                path(&fixture.a),
            ]);
        } else {
            arguments.extend([path(&fixture.a), path(&fixture.p)]);
        }
        let output = fixture.run(&arguments);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(output.stdout, b"X");
    }
    fixture.unchanged();
}

#[test]
fn input_after_and_step_limit_flags_keep_their_behavior() {
    // Output R; loop reading console until nonzero input; output it; HALT.
    let fixture = Fixture::new(&[
        0x3e, b'R', 0xd3, 0, 0xdb, 0, 0xb7, 0x28, 0xfb, 0xd3, 0, 0x76,
    ]);
    let output = fixture.run(&[
        word("--input-ascii"),
        word("X"),
        word("--input-after"),
        word("R"),
        word("--max-steps"),
        word("100000"),
        path(&fixture.rom),
        path(&fixture.a),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.stdout, b"RX");
    let output = fixture.run(&[
        word("--input-ascii"),
        word(""),
        word("--max-steps"),
        word("1000"),
        path(&fixture.rom),
        path(&fixture.a),
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("step limit"));
    fixture.unchanged();
}

#[test]
fn invalid_sparse_arguments_fail_before_guest_output_or_disk_changes() {
    let fixture = Fixture::new(&[0x3e, b'!', 0xd3, 0, 0x76]);
    let a = fixture.a.to_str().unwrap();
    let p = fixture.p.to_str().unwrap();
    let cases: Vec<(Vec<&str>, &str)> = vec![
        (vec!["--slots", "0"], "1 through 16"),
        (vec!["--slots", "17"], "1 through 16"),
        (vec!["--slots", "-1"], "decimal integer"),
        (vec!["--slots", "1.5"], "decimal integer"),
        (vec!["--slots", "2", "--slots", "2"], "only once"),
        (vec!["--drive", "A", a], "requires --slots"),
        (
            vec!["--slots", "2", "--drive", "B", p],
            "requires boot media in A",
        ),
        (
            vec!["--slots", "2", "--drive", "A", a, "--drive", "A", a],
            "more than once",
        ),
        (vec!["--slots", "2", "--drive", "P", p], "outside"),
        (vec!["--slots", "2", "--drive", "Q", p], "uppercase letter"),
        (vec!["--slots", "2", "--drive", "a", a], "uppercase letter"),
        (vec!["--slots", "2", "--drive", "AA", a], "uppercase letter"),
        (
            vec!["--slots", "2", "--drive", "A", a, p],
            "positional drive",
        ),
        (
            vec!["--slots", "2", "--drive", "A", "--max-steps", "1"],
            "image path",
        ),
        (vec!["--image-bytes", "0", a], "positive multiple"),
        (vec!["--image-bytes", "513", a], "positive multiple"),
        (vec!["--image-bytes", "+512", a], "decimal integer"),
        (
            vec!["--image-bytes", "18446744073709551616", a],
            "too large",
        ),
        (
            vec!["--image-bytes", "512", "--image-bytes", "512", a],
            "only once",
        ),
        (vec!["--input-after", "X", a], "requires --input-ascii"),
    ];
    for (arguments, message) in cases {
        let mut arguments: Vec<_> = arguments.into_iter().map(word).collect();
        // ROM first, to distinguish explicit-mode positional disks from ROM.
        arguments.insert(0, path(&fixture.rom));
        let output = fixture.run(&arguments);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(error.contains(message), "expected {message:?}, got {error}");
        fixture.unchanged();
    }
    for option in ["--slots", "--drive", "--image-bytes"] {
        let output = fixture.run(&[path(&fixture.rom), word(option)]);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
    let output = fixture.run(&[
        path(&fixture.rom),
        word("--slots"),
        word("1"),
        word("--drive"),
        word("A"),
    ]);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("image path"));
}

#[test]
fn exact_size_and_alias_assertions_fail_before_guest_execution_and_release_locks() {
    let fixture = Fixture::new(&[0x3e, b'!', 0xd3, 0, 0x76]);
    for arguments in [
        vec![
            path(&fixture.rom),
            path(&fixture.a),
            word("--image-bytes"),
            word("2097152"),
        ],
        vec![
            path(&fixture.rom),
            word("--slots"),
            word("16"),
            word("--drive"),
            word("A"),
            path(&fixture.a),
            word("--drive"),
            word("P"),
            path(&fixture.a),
        ],
    ] {
        let output = fixture.run(&arguments);
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
        let output = fixture.run(&[path(&fixture.rom), path(&fixture.a)]);
        assert!(output.status.success());
        assert_eq!(output.stdout, b"!");
        fixture.unchanged();
    }
}

#[test]
#[cfg(target_os = "linux")]
fn sparse_paths_preserve_non_utf8_names() {
    let fixture = Fixture::new(&[0x76]);
    let non_utf8 = fixture
        .directory
        .join(OsString::from_vec(b"disk-\xff.img".to_vec()));
    fs::copy(&fixture.a, &non_utf8).unwrap();
    let output = fixture.run(&[
        path(&fixture.rom),
        word("--slots"),
        word("1"),
        word("--drive"),
        word("A"),
        path(&non_utf8),
    ]);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(fs::read(non_utf8).unwrap(), [b'A'; 512]);
}

#[test]
fn non_utf8_image_arguments_reach_filesystem_validation() {
    let fixture = Fixture::new(&[0x76]);
    let non_utf8 = fixture
        .directory
        .join(OsString::from_vec(b"missing-\xff.img".to_vec()));
    let output = fixture.run(&[
        path(&fixture.rom),
        word("--slots"),
        word("1"),
        word("--drive"),
        word("A"),
        path(&non_utf8),
    ]);
    assert!(!output.status.success());
    assert!(!String::from_utf8_lossy(&output.stderr).contains("requires UTF-8"));
    assert!(output.stdout.is_empty());
}
