//! Real native backing-store ownership versus a separate CLI process. The host
//! is a dev-only dependency; these tests do not execute a guest or prove disks
//! can boot. A pipe handshake holds A/P locks without timing-based sleeps.

use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};

use triptych_cpm_image::{CpmGeometry, CpmImage};
use triptych_host_native::FileSectorStore;

static SEQUENCE: AtomicU64 = AtomicU64::new(0);

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "triptych-cli-owner-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn path(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct NativeOwner {
    child: Child,
    _stdout: BufReader<ChildStdout>,
}
impl NativeOwner {
    fn start(a: &Path, p: &Path) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "native_owner_process", "--nocapture"])
            .env("TRIPTYCH_TEST_OWNER_A", a)
            .env("TRIPTYCH_TEST_OWNER_P", p)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert_ne!(
                stdout.read_line(&mut line).unwrap(),
                0,
                "native owner exited before acquiring its media"
            );
            if line.contains("TRIPTYCH_OWNER_READY") {
                break;
            }
        }
        Self {
            child,
            _stdout: stdout,
        }
    }
}
impl Drop for NativeOwner {
    fn drop(&mut self) {
        let _ = self.child.stdin.take().unwrap().write_all(b"release");
        let _ = self.child.wait();
    }
}

#[test]
fn native_owner_process() {
    let Some(a) = std::env::var_os("TRIPTYCH_TEST_OWNER_A") else {
        return;
    };
    let p = std::env::var_os("TRIPTYCH_TEST_OWNER_P").unwrap();
    let mut slots = vec![None; 16];
    slots[0] = Some(PathBuf::from(a));
    slots[15] = Some(PathBuf::from(p));
    let _store = FileSectorStore::open_slots(&slots).unwrap();
    println!("TRIPTYCH_OWNER_READY");
    std::io::stdout().flush().unwrap();
    let mut release = [0];
    std::io::stdin().read_exact(&mut release).unwrap();
}

fn run(arguments: &[&Path]) -> std::process::Output {
    Command::new(env!("CARGO_BIN_EXE_triptych-cpm"))
        .args(arguments)
        .output()
        .unwrap()
}

#[test]
fn native_a_and_p_exclude_cli_reads_imports_and_forced_replacement_until_release() {
    let directory = Directory::new();
    let a = directory.path("a.img");
    let p = directory.path("p.img");
    let offline = directory.path("offline.img");
    let input = directory.path("input.txt");
    let bytes = CpmImage::blank(CpmGeometry::Triptych2M)
        .install("INPUT.TXT", b"source text")
        .unwrap()
        .into_working_bytes();
    for path in [&a, &p, &offline] {
        fs::write(path, &bytes).unwrap();
    }
    fs::write(&input, b"new text").unwrap();
    let owner = NativeOwner::start(&a, &p);
    for active in [&a, &p] {
        for arguments in [
            vec![Path::new("list"), active],
            vec![Path::new("import"), active, &input, Path::new("INPUT.TXT")],
            vec![
                Path::new("export"),
                Path::new("--force"),
                &offline,
                Path::new("INPUT.TXT"),
                active,
            ],
        ] {
            let result = run(&arguments);
            assert!(!result.status.success());
            assert!(String::from_utf8_lossy(&result.stderr).contains("already locked"));
        }
        assert_eq!(fs::read(active).unwrap(), bytes);
    }
    drop(owner);
    assert!(
        run(&[Path::new("import"), &p, &input, Path::new("INPUT.TXT")])
            .status
            .success()
    );
    assert_ne!(fs::read(&p).unwrap(), bytes);
    assert_eq!(fs::read(&a).unwrap(), bytes);
    assert_eq!(fs::read(&offline).unwrap(), bytes);
}

#[cfg(unix)]
#[test]
fn native_lock_covers_hard_link_and_symlink_aliases_even_for_read_only_media() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let directory = Directory::new();
    let a = directory.path("a.img");
    let p = directory.path("readonly.img");
    let hard = directory.path("hard.img");
    let symbolic = directory.path("symbolic.img");
    let input = directory.path("input.txt");
    let bytes = CpmImage::blank(CpmGeometry::Triptych2M).into_working_bytes();
    fs::write(&a, &bytes).unwrap();
    fs::write(&p, &bytes).unwrap();
    fs::write(&input, b"new text").unwrap();
    fs::set_permissions(&p, fs::Permissions::from_mode(0o444)).unwrap();
    fs::hard_link(&p, &hard).unwrap();
    symlink(&p, &symbolic).unwrap();
    let owner = NativeOwner::start(&a, &p);
    for alias in [&hard, &symbolic] {
        let result = run(&[Path::new("import"), alias, &input, Path::new("INPUT.TXT")]);
        assert!(!result.status.success());
        assert!(String::from_utf8_lossy(&result.stderr).contains("already locked"));
        assert_eq!(fs::read(alias).unwrap(), bytes);
    }
    drop(owner);
    assert!(run(&[Path::new("list"), &symbolic]).status.success());
}
