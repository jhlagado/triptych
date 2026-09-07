use super::*;

struct Directory(PathBuf);

impl Directory {
    fn new() -> Self {
        let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "triptych-file-tests-{}-{sequence}",
            std::process::id()
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

fn assert_locked(path: &Path) {
    let contender = File::open(path).unwrap();
    assert!(
        matches!(contender.try_lock(), Err(TryLockError::WouldBlock)),
        "{} was not exclusively owned",
        path.display()
    );
}

fn assert_available(path: &Path) {
    let contender = File::open(path).unwrap();
    contender.try_lock().unwrap();
    contender.unlock().unwrap();
}

#[test]
fn locked_candidate_spans_rename_and_old_inode_remains_owned() {
    let directory = Directory::new();
    let path = directory.path("image.img");
    let alias = directory.path("old-inode.img");
    fs::write(&path, b"original").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    let old = LockedFile::open(&path).unwrap();
    let output = Output::replace(&old);
    let mut candidate = Candidate::create(&path, b"replacement", None).unwrap();
    assert_locked(&candidate.file.path);
    output.install(&mut candidate, &[]).unwrap();
    assert_locked(&path);
    assert_locked(&alias);
    assert_eq!(fs::read(&path).unwrap(), b"replacement");
    assert_eq!(fs::read(&alias).unwrap(), b"original");
    candidate.finish(&path).unwrap();
    drop(candidate);
    assert_available(&path);
    drop(output);
    drop(old);
    assert_available(&alias);
}

#[test]
fn initially_absent_force_destination_cannot_clobber_a_later_file() {
    let directory = Directory::new();
    let path = directory.path("new.img");
    let output = Output::replace_or_new(&path).unwrap();
    let mut candidate = Candidate::create(&path, b"candidate", None).unwrap();
    fs::write(&path, b"appeared after preparation").unwrap();
    assert_eq!(
        output.install(&mut candidate, &[]).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    drop(candidate);
    assert_eq!(fs::read(&path).unwrap(), b"appeared after preparation");
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 1);
}

#[cfg(unix)]
#[test]
fn absent_and_force_publication_preserve_dangling_symlinks() {
    use std::os::unix::fs::symlink;
    let directory = Directory::new();
    let path = directory.path("new.img");
    let target = directory.path("missing.img");
    let output = Output::replace_or_new(&path).unwrap();
    let mut candidate = Candidate::create(&path, b"candidate", None).unwrap();
    symlink(&target, &path).unwrap();
    assert_eq!(
        output.install(&mut candidate, &[]).unwrap_err().kind(),
        io::ErrorKind::AlreadyExists
    );
    assert!(Output::new(&path).is_err());
    assert!(Output::replace_or_new(&path).is_err());
    assert_eq!(fs::read_link(&path).unwrap(), target);
    assert!(!target.exists());
}

#[test]
fn changed_destination_inode_is_rejected_before_rename_and_releases_locks() {
    let directory = Directory::new();
    let path = directory.path("image.img");
    let retained = directory.path("retained.img");
    fs::write(&path, b"original").unwrap();
    let output = Output::replace_or_new(&path).unwrap();
    let mut candidate = Candidate::create(&path, b"candidate", None).unwrap();
    fs::rename(&path, &retained).unwrap();
    fs::write(&path, b"different owner").unwrap();
    assert_locked(&retained);
    assert_eq!(
        output.install(&mut candidate, &[]).unwrap_err().kind(),
        io::ErrorKind::InvalidData
    );
    drop(candidate);
    drop(output);
    assert_eq!(fs::read(&path).unwrap(), b"different owner");
    assert_eq!(fs::read(&retained).unwrap(), b"original");
    assert_available(&retained);
    assert_eq!(fs::read_dir(&directory.0).unwrap().count(), 2);
}

#[test]
fn changed_input_path_rejects_publication_without_replacing_output() {
    let directory = Directory::new();
    let source = directory.path("source.img");
    let moved = directory.path("moved.img");
    let destination = directory.path("destination.img");
    fs::write(&source, b"input").unwrap();
    fs::write(&destination, b"destination").unwrap();
    let input = LockedFile::open(&source).unwrap();
    let output = Output::replace_or_new(&destination).unwrap();
    let mut candidate = Candidate::create(&destination, b"candidate", None).unwrap();
    fs::rename(&source, &moved).unwrap();
    fs::write(&source, b"new input owner").unwrap();
    assert!(output.install(&mut candidate, &[&input]).is_err());
    assert_eq!(fs::read(&destination).unwrap(), b"destination");
    assert_eq!(fs::read(&source).unwrap(), b"new input owner");
    assert_eq!(fs::read(&moved).unwrap(), b"input");
}

#[test]
fn cleanup_failure_after_publication_is_not_reported_as_rollback() {
    let directory = Directory::new();
    let path = directory.path("new.img");
    let output = Output::new(&path).unwrap();
    let mut candidate = Candidate::create(&path, b"published", None).unwrap();
    output.install(&mut candidate, &[]).unwrap();
    // Deterministic cleanup failure: an unrelated entry takes the temp name.
    // The final hard link is already committed and must never be removed.
    fs::remove_file(&candidate.file.path).unwrap();
    fs::create_dir(&candidate.file.path).unwrap();
    let error = candidate.finish(&path).unwrap_err().to_string();
    assert!(error.contains("was published, but temporary cleanup failed"));
    let temporary = candidate.file.path.clone();
    drop(candidate);
    assert!(temporary.is_dir());
    assert_eq!(fs::read(&path).unwrap(), b"published");
    assert_available(&path);
}

#[test]
fn alias_and_partial_acquisition_errors_do_not_leave_owned_inputs_locked() {
    let directory = Directory::new();
    let path = directory.path("input.img");
    let alias = directory.path("alias.img");
    fs::write(&path, b"input").unwrap();
    fs::hard_link(&path, &alias).unwrap();
    {
        let _input = LockedFile::open(&path).unwrap();
        assert!(LockedFile::open(&alias).is_err());
        assert!(Output::replace_or_new(&alias).is_err());
        assert!(LockedFile::open(&directory.path("missing")).is_err());
    }
    assert_available(&path);
    assert_available(&alias);
}

#[cfg(unix)]
#[test]
fn read_only_regular_file_is_exclusively_owned_and_permissions_survive_replacement() {
    use std::os::unix::fs::PermissionsExt;
    let directory = Directory::new();
    let path = directory.path("readonly.img");
    fs::write(&path, b"old").unwrap();
    fs::set_permissions(&path, Permissions::from_mode(0o444)).unwrap();
    let old = LockedFile::open(&path).unwrap();
    assert_locked(&path);
    Output::replace(&old).publish(b"new", &[]).unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o444
    );
}

#[cfg(unix)]
#[test]
fn non_regular_inputs_are_rejected_before_opening_a_fifo() {
    let directory = Directory::new();
    let fifo = directory.path("fifo");
    assert!(std::process::Command::new("mkfifo")
        .arg(&fifo)
        .status()
        .unwrap()
        .success());
    assert!(LockedFile::open(&directory.0).is_err());
    assert!(LockedFile::open(&fifo).is_err());
}
