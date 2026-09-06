use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use triptych_cpm_image::{CpmGeometry, CpmImage, DISK_IMAGE_BYTES, WORKING_IMAGE_BYTES};

struct TemporaryDirectory(PathBuf);

static TEMPORARY_DIRECTORY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

impl TemporaryDirectory {
    fn new() -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let sequence = TEMPORARY_DIRECTORY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "triptych-cpm-cli-{}-{nonce}-{sequence}",
            std::process::id()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }

    fn join(&self, path: impl AsRef<Path>) -> PathBuf {
        self.0.join(path)
    }
}

impl Drop for TemporaryDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn run(arguments: &[&Path]) -> std::process::Output {
    let mut command = Command::new(env!("CARGO_BIN_EXE_triptych-cpm"));
    for argument in arguments {
        command.arg(argument);
    }
    command.output().unwrap()
}

#[test]
fn creates_lists_imports_and_exports_a_working_image() {
    let temporary = TemporaryDirectory::new();
    let source = temporary.join("source.img");
    let working = temporary.join("working.img");
    let mac_file = temporary.join("hello.asm");
    let exported = temporary.join("exported.asm");
    fs::write(&source, vec![0xe5; DISK_IMAGE_BYTES]).unwrap();
    fs::write(&mac_file, b"ORG 100H\r\nRET\r\n").unwrap();

    let create = run(&[Path::new("create"), &source, &working]);
    assert!(
        create.status.success(),
        "{}",
        String::from_utf8_lossy(&create.stderr)
    );
    assert_eq!(
        fs::metadata(&working).unwrap().len(),
        WORKING_IMAGE_BYTES as u64
    );

    let import = run(&[
        Path::new("import"),
        &working,
        &mac_file,
        Path::new("INPUT.ASM"),
    ]);
    assert!(
        import.status.success(),
        "{}",
        String::from_utf8_lossy(&import.stderr)
    );

    let list = run(&[Path::new("list"), &working]);
    assert!(
        list.status.success(),
        "{}",
        String::from_utf8_lossy(&list.stderr)
    );
    let listing = String::from_utf8(list.stdout).unwrap();
    assert!(listing.contains("INPUT.ASM"));
    assert!(listing.contains("Free:"));

    let export = run(&[
        Path::new("export"),
        Path::new("--text"),
        &working,
        Path::new("INPUT.ASM"),
        &exported,
    ]);
    assert!(
        export.status.success(),
        "{}",
        String::from_utf8_lossy(&export.stderr)
    );
    assert_eq!(fs::read(&exported).unwrap(), fs::read(&mac_file).unwrap());
}

#[test]
fn failed_import_does_not_publish_a_partial_image() {
    let temporary = TemporaryDirectory::new();
    let image = temporary.join("working.img");
    let mac_file = temporary.join("input.bin");
    let original = vec![0xe5; WORKING_IMAGE_BYTES];
    fs::write(&image, &original).unwrap();
    fs::write(&mac_file, [1, 2, 3]).unwrap();

    let output = run(&[
        Path::new("import"),
        &image,
        &mac_file,
        Path::new("TOO-LONG9.COM"),
    ]);
    assert!(!output.status.success());
    assert_eq!(fs::read(&image).unwrap(), original);
}

#[test]
fn formats_and_migrates_large_images_without_overwriting_sources_or_destinations() {
    let temporary = TemporaryDirectory::new();
    let source = temporary.join("legacy.img");
    let system = temporary.join("system.bin");
    let blank = temporary.join("blank.img");
    let migrated = temporary.join("migrated.img");
    let before = CpmImage::blank(CpmGeometry::Ibm3740)
        .install("SOURCE.NU", b"sub main()\r\nend\r\n")
        .unwrap();
    fs::write(&source, before.as_bytes()).unwrap();
    let system_bytes = vec![0x52; CpmGeometry::Triptych8M.system_bytes()];
    fs::write(&system, &system_bytes).unwrap();
    let format = run(&[
        Path::new("format"),
        Path::new("triptych-cpm-8m-v1"),
        &system,
        &blank,
    ]);
    assert!(
        format.status.success(),
        "{}",
        String::from_utf8_lossy(&format.stderr)
    );
    let blank_bytes = fs::read(&blank).unwrap();
    assert_eq!(blank_bytes.len(), 8 * 1024 * 1024);
    assert_eq!(&blank_bytes[..system_bytes.len()], &system_bytes);
    let migrate = run(&[
        Path::new("migrate"),
        Path::new("triptych-cpm-8m-v1"),
        &source,
        &system,
        &migrated,
    ]);
    assert!(
        migrate.status.success(),
        "{}",
        String::from_utf8_lossy(&migrate.stderr)
    );
    let after = CpmImage::from_bytes(fs::read(&migrated).unwrap()).unwrap();
    assert_eq!(after.geometry(), CpmGeometry::Triptych8M);
    assert_eq!(
        after.read("SOURCE.NU").unwrap().unwrap().bytes,
        before.read("SOURCE.NU").unwrap().unwrap().bytes
    );
    assert_eq!(fs::read(&source).unwrap(), before.as_bytes());

    let repeated = run(&[
        Path::new("migrate"),
        Path::new("triptych-cpm-8m-v1"),
        &source,
        &system,
        &migrated,
    ]);
    assert!(!repeated.status.success());
    assert_eq!(fs::read(&migrated).unwrap(), after.as_bytes());
    let same_path = run(&[
        Path::new("migrate"),
        Path::new("triptych-cpm-8m-v1"),
        &source,
        &system,
        &source,
    ]);
    assert!(!same_path.status.success());
    assert_eq!(fs::read(&source).unwrap(), before.as_bytes());
}

#[test]
fn rejected_geometry_or_system_area_does_not_create_a_destination() {
    let temporary = TemporaryDirectory::new();
    let system = temporary.join("short-system.bin");
    let target = temporary.join("disk.img");
    fs::write(&system, [0; 128]).unwrap();
    for format in ["triptych-cpm-8m-v1", "unknown"] {
        let rejected = run(&[Path::new("format"), Path::new(format), &system, &target]);
        assert!(!rejected.status.success());
        assert!(!target.exists());
        assert_eq!(fs::read(&system).unwrap(), [0; 128]);
    }
}
