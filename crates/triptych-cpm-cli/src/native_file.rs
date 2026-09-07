//! Cooperative ownership for the host-only CLI, independent of disk geometry.
//!
//! Locks protect opened regular-file inodes, including read-only inputs. A
//! replacement holds both the old inode and the candidate inode through rename.
//! They exclude cooperating owners, not arbitrary editors or hostile pathname
//! races. Preflight avoids ordinary FIFOs/devices; it is not an openat sandbox.

use std::fs::{self, File, Metadata, OpenOptions, Permissions, TryLockError};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static TEMPORARY_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[cfg(unix)]
fn identity(metadata: &Metadata) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn identity(_metadata: &Metadata) -> io::Result<(u64, u64)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exclusive file identity is currently supported on macOS/Linux only",
    ))
}

fn regular(path: &Path, metadata: &Metadata) -> io::Result<()> {
    if metadata.is_file() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} must be a regular file", path.display()),
        ))
    }
}

fn lock(file: &File, path: &Path) -> io::Result<()> {
    file.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => io::Error::new(
            io::ErrorKind::WouldBlock,
            format!("{} is already locked by another file owner", path.display()),
        ),
        TryLockError::Error(error) => io::Error::new(
            error.kind(),
            format!(
                "{} cannot acquire an exclusive file lock: {error}",
                path.display()
            ),
        ),
    })
}

/// Never exposes or clones the owned descriptor. Explicit unlock on drop also
/// releases ownership if a concurrent fork briefly inherited the descriptor.
pub(crate) struct LockedFile {
    path: PathBuf,
    file: File,
    inode: (u64, u64),
    entry: (u64, u64),
}

impl LockedFile {
    pub(crate) fn open(path: &Path) -> io::Result<Self> {
        regular(path, &fs::metadata(path)?)?;
        let entry = identity(&fs::symlink_metadata(path)?)?;
        let file = File::open(path)?;
        lock(&file, path)?;
        // Construct the guard before fallible post-lock validation.
        let mut result = Self {
            path: path.to_owned(),
            file,
            inode: (0, 0),
            entry,
        };
        let metadata = result.file.metadata()?;
        regular(path, &metadata)?;
        result.inode = identity(&metadata)?;
        result.check_path()?;
        Ok(result)
    }

    pub(crate) fn read(&self) -> io::Result<Vec<u8>> {
        self.check_path()?;
        let mut bytes = Vec::new();
        (&self.file).read_to_end(&mut bytes)?;
        self.check_path()?;
        Ok(bytes)
    }

    fn check_path(&self) -> io::Result<()> {
        if identity(&fs::symlink_metadata(&self.path)?)? != self.entry
            || identity(&fs::metadata(&self.path)?)? != self.inode
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "{} changed identity while owned; no replacement published",
                    self.path.display()
                ),
            ));
        }
        Ok(())
    }
}

impl Drop for LockedFile {
    fn drop(&mut self) {
        let _ = self.file.unlock();
    }
}

enum Previous<'a> {
    Absent,
    Owned(LockedFile),
    Borrowed(&'a LockedFile),
}

/// Captures whether this pathname existed before preparing a candidate. Even
/// --force uses no-clobber publication when it was initially absent.
pub(crate) struct Output<'a> {
    path: PathBuf,
    previous: Previous<'a>,
}

impl Output<'static> {
    pub(crate) fn new(path: &Path) -> io::Result<Self> {
        require_absent(path)?;
        Ok(Self {
            path: path.to_owned(),
            previous: Previous::Absent,
        })
    }

    pub(crate) fn replace_or_new(path: &Path) -> io::Result<Self> {
        match fs::symlink_metadata(path) {
            // A dangling symlink is an existing entry, never an absent target.
            Ok(_) => Ok(Self {
                path: path.to_owned(),
                previous: Previous::Owned(LockedFile::open(path)?),
            }),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Self::new(path),
            Err(error) => Err(error),
        }
    }
}

impl<'a> Output<'a> {
    pub(crate) fn replace(file: &'a LockedFile) -> Self {
        Self {
            path: file.path.clone(),
            previous: Previous::Borrowed(file),
        }
    }

    fn previous(&self) -> Option<&LockedFile> {
        match &self.previous {
            Previous::Absent => None,
            Previous::Owned(file) => Some(file),
            Previous::Borrowed(file) => Some(file),
        }
    }

    pub(crate) fn publish(self, bytes: &[u8], inputs: &[&LockedFile]) -> io::Result<()> {
        let permissions = self
            .previous()
            .map(|file| file.file.metadata().map(|m| m.permissions()))
            .transpose()?;
        let mut candidate = Candidate::create(&self.path, bytes, permissions)?;
        self.install(&mut candidate, inputs)?;
        candidate.finish(&self.path)
    }

    // Kept separate from candidate construction so tests can exercise the exact
    // pre-publication boundary without timers or environment-controlled hooks.
    fn install(&self, candidate: &mut Candidate, inputs: &[&LockedFile]) -> io::Result<()> {
        for input in inputs {
            input.check_path()?;
        }
        candidate.file.check_path()?;
        if let Some(previous) = self.previous() {
            previous.check_path()?;
            fs::rename(&candidate.file.path, &self.path)?;
        } else {
            // Atomic no-clobber even if a file or symlink appeared since open.
            fs::hard_link(&candidate.file.path, &self.path)?;
        }
        Ok(())
    }
}

fn require_absent(path: &Path) -> io::Result<()> {
    match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
        Ok(_) => Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("{} already exists", path.display()),
        )),
    }
}

struct Candidate {
    file: LockedFile,
}

impl Candidate {
    fn create(path: &Path, bytes: &[u8], permissions: Option<Permissions>) -> io::Result<Self> {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let name = path.file_name().ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "output path has no filename")
        })?;
        let sequence = TEMPORARY_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temporary = parent.join(format!(
            ".{}.triptych-cpm-{}-{sequence}.tmp",
            name.to_string_lossy(),
            std::process::id()
        ));
        // A create_new failure never grants ownership of an existing temporary.
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        let metadata = file.metadata()?;
        let inode = identity(&metadata)?;
        let mut candidate = Self {
            file: LockedFile {
                path: temporary,
                file,
                inode,
                entry: inode,
            },
        };
        lock(&candidate.file.file, &candidate.file.path)?;
        candidate.file.file.write_all(bytes)?;
        if let Some(permissions) = permissions {
            candidate.file.file.set_permissions(permissions)?;
        }
        candidate.file.file.sync_all()?;
        Ok(candidate)
    }

    fn remove_temporary(&self) -> io::Result<()> {
        match fs::symlink_metadata(&self.file.path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error),
            Ok(metadata) if identity(&metadata)? == self.file.inode => {
                fs::remove_file(&self.file.path)
            }
            Ok(_) => Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "temporary pathname changed; unrelated entry preserved",
            )),
        }
    }

    fn finish(&self, published: &Path) -> io::Result<()> {
        self.remove_temporary().map_err(|error| {
            io::Error::new(
                error.kind(),
                format!(
                    "{} was published, but temporary cleanup failed: {error}",
                    published.display()
                ),
            )
        })
    }
}

impl Drop for Candidate {
    fn drop(&mut self) {
        let _ = self.remove_temporary();
    }
}

#[cfg(test)]
#[path = "native_file_tests.rs"]
mod tests;
