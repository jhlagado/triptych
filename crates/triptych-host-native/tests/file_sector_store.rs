#![cfg(unix)]

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufRead, BufReader, Read, Write};
use std::os::unix::fs::{symlink, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use triptych_cpu_core::{SectorStore, StorageFault};
use triptych_host_native::FileSectorStore;

static NEXT: AtomicU64 = AtomicU64::new(0);
struct Temporary(PathBuf);
impl Temporary {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "triptych-slots-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn image(&self, name: &str, length: usize, byte: u8) -> PathBuf {
        let path = self.0.join(name);
        fs::write(&path, vec![byte; length]).unwrap();
        path
    }
}
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn sparse_slots_preserve_numbers_and_independent_identical_media() {
    let temp = Temporary::new();
    let mut slots = vec![None; 16];
    for index in [0, 7, 8, 15] {
        slots[index] = Some(temp.image(&format!("{index}.img"), 1024, 0x44));
    }
    let mut store = FileSectorStore::open_slots(&slots).unwrap();
    store.require_image_bytes(1024).unwrap();
    assert!(store.require_image_bytes(512).is_err());
    for invalid in [0, 513] {
        assert!(store.require_image_bytes(invalid).is_err());
    }
    for index in [0, 7, 8, 15] {
        assert_eq!(store.path(index), slots[usize::from(index)].as_deref());
        assert_eq!(store.drive_info(index).unwrap().sectors, 2);
        let mut bytes = [0; 512];
        store.read_sector(index, 1, &mut bytes).unwrap();
        assert_eq!(bytes, [0x44; 512]);
        store.write_sector(index, 1, &[index; 512]).unwrap();
        store.flush(index).unwrap();
        assert_eq!(store.read_sector(index, 2, &mut bytes), Err(StorageFault));
        assert_eq!(store.write_sector(index, 2, &[0; 512]), Err(StorageFault));
    }
    for index in [1, 6, 9, 14, 16, 255] {
        let mut bytes = [0xa5; 512];
        assert_eq!(store.path(index), None);
        assert_eq!(store.drive_info(index), None);
        assert_eq!(store.read_sector(index, 0, &mut bytes), Err(StorageFault));
        assert_eq!(bytes, [0xa5; 512]);
        assert_eq!(store.write_sector(index, 0, &[0; 512]), Err(StorageFault));
        assert_eq!(store.flush(index), Err(StorageFault));
    }
    drop(store);
    for index in [0, 7, 8, 15] {
        let bytes = fs::read(slots[index].as_ref().unwrap()).unwrap();
        assert_eq!(&bytes[..512], &[0x44; 512]);
        assert_eq!(&bytes[512..], &[index as u8; 512]);
    }
}

#[test]
fn configured_count_bounds_and_empty_slots() {
    assert!(FileSectorStore::open_slots(&[]).is_err());
    assert!(FileSectorStore::open_slots(&vec![None; 17]).is_err());
    let mut store = FileSectorStore::open_slots(&[None]).unwrap();
    assert_eq!(store.drive_info(0), None);
    assert_eq!(store.flush(0), Err(StorageFault));
}

#[test]
fn aliases_reject_and_partial_attachment_releases_every_lock() {
    let temp = Temporary::new();
    let a = temp.image("a.img", 512, 0x41);
    let b = temp.image("b.img", 512, 0x42);
    let hard = temp.0.join("hard.img");
    let soft = temp.0.join("soft.img");
    fs::hard_link(&a, &hard).unwrap();
    symlink(&a, &soft).unwrap();
    for alias in [a.clone(), temp.0.join("./a.img"), hard, soft] {
        let result = FileSectorStore::open_slots(&[Some(a.clone()), Some(b.clone()), Some(alias)]);
        let error = result.err().expect("alias must fail");
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("aliases"));
        let reopened = FileSectorStore::open(&[a.clone(), b.clone()]).unwrap();
        drop(reopened);
    }
    assert_eq!(fs::read(a).unwrap(), vec![0x41; 512]);
    assert_eq!(fs::read(b).unwrap(), vec![0x42; 512]);
}

#[test]
fn invalid_later_files_release_earlier_locks_without_writing() {
    let temp = Temporary::new();
    let a = temp.image("a.img", 512, 0x41);
    for length in [0, 1, 511, 513] {
        let invalid = temp.image("invalid.img", length, 0x49);
        assert!(FileSectorStore::open(&[a.clone(), invalid.clone()]).is_err());
        assert_eq!(fs::read(&invalid).unwrap(), vec![0x49; length]);
        drop(FileSectorStore::open(std::slice::from_ref(&a)).unwrap());
    }
    for invalid in [temp.0.clone(), temp.0.join("missing.img")] {
        assert!(FileSectorStore::open(&[a.clone(), invalid]).is_err());
        drop(FileSectorStore::open(std::slice::from_ref(&a)).unwrap());
    }
    let fifo = temp.0.join("fifo");
    assert!(Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    assert!(FileSectorStore::open(&[a.clone(), fifo]).is_err());
    assert_eq!(fs::read(a).unwrap(), vec![0x41; 512]);
}

#[test]
fn capacity_overflow_rejects_sparse_files_before_io() {
    let temp = Temporary::new();
    let path = temp.image("too-large.img", 512, 0x41);
    let file = OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len((u64::from(u32::MAX) / 4 + 1) * 512).unwrap();
    drop(file);
    assert!(FileSectorStore::open(std::slice::from_ref(&path)).is_err());
    let file = OpenOptions::new().write(true).open(&path).unwrap();
    file.set_len(512).unwrap();
    drop(file);
    drop(FileSectorStore::open(&[path]).unwrap());
}

#[test]
fn read_only_media_never_bypass_exclusive_ownership() {
    let temp = Temporary::new();
    let path = temp.image("readonly.img", 512, 0x41);
    fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
    // Root may still obtain write access: verify the read-only branch only when
    // the OS actually denies a writable handle, not from permission bits alone.
    let writable = OpenOptions::new().write(true).open(&path).is_ok();
    match FileSectorStore::open(std::slice::from_ref(&path)) {
        Ok(mut store) => {
            assert_eq!(store.drive_info(0).unwrap().writable, writable);
            if !writable {
                assert_eq!(store.write_sector(0, 0, &[0; 512]), Err(StorageFault));
            }
            let contender = File::open(&path).unwrap();
            assert!(contender.try_lock().is_err());
            assert!(FileSectorStore::open(std::slice::from_ref(&path)).is_err());
        }
        Err(error) => assert!(
            error.to_string().contains("exclusive image lock"),
            "{error}"
        ),
    }
    assert_eq!(fs::read(&path).unwrap(), vec![0x41; 512]);
}

// A separate process is essential: same-process lock behavior alone does not
// prove the native attachment lifetime. Pipes provide a bounded readiness gate.
#[test]
fn lock_holder_child() {
    let Some(path) = std::env::var_os("TRIPTYCH_LOCK_TEST_IMAGE") else {
        return;
    };
    let _store = FileSectorStore::open(&[PathBuf::from(path)]).unwrap();
    println!("LOCK-READY");
    io::stdout().flush().unwrap();
    let _ = io::stdin().read(&mut [0]);
}

struct Holder(Child);
impl Holder {
    fn new(path: &Path) -> Self {
        let child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "lock_holder_child", "--nocapture"])
            .env("TRIPTYCH_LOCK_TEST_IMAGE", path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap();
        let mut holder = Self(child);
        let stdout = holder.0.stdout.take().unwrap();
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if line.unwrap() == "LOCK-READY" {
                    let _ = send.send(());
                }
            }
        });
        receive
            .recv_timeout(Duration::from_secs(10))
            .expect("lock-holder readiness");
        holder
    }
}
impl Drop for Holder {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

#[test]
fn another_process_is_excluded_until_normal_or_forced_exit() {
    let temp = Temporary::new();
    let a = temp.image("a.img", 512, 0x41);
    let b = temp.image("b.img", 512, 0x42);
    for forced in [false, true] {
        let mut holder = Holder::new(&b);
        let error = FileSectorStore::open(&[a.clone(), b.clone()])
            .err()
            .expect("locked B must fail");
        assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
        drop(FileSectorStore::open(std::slice::from_ref(&a)).unwrap());
        if forced {
            holder.0.kill().unwrap();
        } else {
            holder.0.stdin.take().unwrap().write_all(b"Q").unwrap();
        }
        let status = holder.0.wait().unwrap();
        assert_eq!(status.success(), !forced);
        drop(FileSectorStore::open(&[a.clone(), b.clone()]).unwrap());
    }
    assert_eq!(fs::read(a).unwrap(), vec![0x41; 512]);
    assert_eq!(fs::read(b).unwrap(), vec![0x42; 512]);
}
