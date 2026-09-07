use std::collections::VecDeque;
use std::fs::{self, File, Metadata, OpenOptions, TryLockError};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, Receiver};

use triptych_cpu_core::{Console, DriveInfo, SectorStore, StorageFault, SECTOR_BYTES};

pub struct TerminalConsole {
    scripted_input: VecDeque<u8>,
    live_input: Option<Receiver<u8>>,
    output: io::Stdout,
    captured_output: Vec<u8>,
}

impl TerminalConsole {
    pub fn open() -> Self {
        let (sender, input) = mpsc::channel();
        std::thread::spawn(move || {
            let stdin = io::stdin();
            for byte in stdin.lock().bytes() {
                let Ok(byte) = byte else {
                    break;
                };
                if sender.send(byte).is_err() {
                    break;
                }
            }
        });
        Self {
            scripted_input: VecDeque::new(),
            live_input: Some(input),
            output: io::stdout(),
            captured_output: Vec::new(),
        }
    }

    pub fn scripted(input: impl IntoIterator<Item = u8>) -> Self {
        Self {
            scripted_input: input.into_iter().collect(),
            live_input: None,
            output: io::stdout(),
            captured_output: Vec::new(),
        }
    }

    pub fn captured_output(&self) -> &[u8] {
        &self.captured_output
    }

    pub fn enqueue_scripted(&mut self, input: impl IntoIterator<Item = u8>) {
        self.scripted_input.extend(input);
    }
}

impl Console for TerminalConsole {
    fn receive(&mut self) -> Option<u8> {
        self.scripted_input.pop_front().or_else(|| {
            self.live_input
                .as_ref()
                .and_then(|input| input.try_recv().ok())
        })
    }

    fn transmit(&mut self, byte: u8) {
        self.captured_output.push(byte);
        self.output
            .write_all(&[byte])
            .and_then(|()| self.output.flush())
            .expect("Triptych terminal output failed");
    }

    fn reset(&mut self) {
        self.scripted_input.clear();
        if let Some(input) = &self.live_input {
            while input.try_recv().is_ok() {}
        }
    }
}

// Explicit unlock releases ownership before close even if a concurrent fork
// briefly inherited the descriptor before exec. This handle is never exposed
// or cloned; the guard owns the sole intended lock lifetime.
struct LockedFile(File);

impl Drop for LockedFile {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

struct DriveFile {
    path: PathBuf,
    file: LockedFile,
    sectors: u32,
    writable: bool,
    identity: (u64, u64),
}

/// Fixed configured slots with independently owned, exclusively locked media.
/// Locks exclude cooperating processes, not arbitrary editors or path changes.
/// Image-management tools must remain offline until they implement this policy.
pub struct FileSectorStore {
    drives: Vec<Option<DriveFile>>,
}

impl FileSectorStore {
    /// Compatibility adapter: the supplied images occupy contiguous slots A onward.
    pub fn open(paths: &[PathBuf]) -> io::Result<Self> {
        Self::open_slots(&paths.iter().cloned().map(Some).collect::<Vec<_>>())
    }

    /// Acquire every medium before publishing a store. An error releases all
    /// earlier handles/locks. Empty configured slots retain their drive numbers.
    /// The launcher, rather than this geometry-neutral provider, requires A.
    pub fn open_slots(paths: &[Option<PathBuf>]) -> io::Result<Self> {
        if !(1..=16).contains(&paths.len()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "configured slot count must be 1 through 16",
            ));
        }
        let mut drives = Vec::with_capacity(paths.len());
        for path in paths {
            drives.push(match path {
                Some(path) => Some(open_drive(path, &drives)?),
                None => None,
            });
        }
        Ok(Self { drives })
    }

    /// Check an explicit launch assertion against the already locked handles.
    /// This does not identify geometry or install a matching resident system.
    pub fn require_image_bytes(&self, expected: u64) -> io::Result<()> {
        if expected == 0 || !expected.is_multiple_of(SECTOR_BYTES as u64) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "image bytes must be a positive multiple of 512",
            ));
        }
        for drive in self.drives.iter().flatten() {
            if drive.file.0.metadata()?.len() != expected {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "{} must contain exactly {expected} image bytes",
                        drive.path.display()
                    ),
                ));
            }
        }
        Ok(())
    }

    pub fn path(&self, drive: u8) -> Option<&Path> {
        self.drives
            .get(usize::from(drive))
            .and_then(Option::as_ref)
            .map(|entry| entry.path.as_path())
    }
}

#[cfg(unix)]
fn file_identity(metadata: &Metadata) -> io::Result<(u64, u64)> {
    use std::os::unix::fs::MetadataExt;
    Ok((metadata.dev(), metadata.ino()))
}

#[cfg(not(unix))]
fn file_identity(_metadata: &Metadata) -> io::Result<(u64, u64)> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "exclusive image identity is currently supported on macOS/Linux only",
    ))
}

fn require_regular(path: &Path, metadata: &Metadata) -> io::Result<()> {
    if !metadata.is_file() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} must be a regular image file", path.display()),
        ));
    }
    Ok(())
}

fn open_drive(path: &Path, previous: &[Option<DriveFile>]) -> io::Result<DriveFile> {
    // Avoid opening an ordinary FIFO/device. The handle check below is the
    // authority; this preflight is not protection against adversarial path races.
    require_regular(path, &fs::metadata(path)?)?;
    let (file, writable) = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => (file, true),
        Err(write_error) => match OpenOptions::new().read(true).open(path) {
            Ok(file) => (file, false),
            Err(_) => return Err(write_error),
        },
    };
    let metadata = file.metadata()?;
    require_regular(path, &metadata)?;
    let identity = file_identity(&metadata)?;
    if previous
        .iter()
        .flatten()
        .any(|drive| drive.identity == identity)
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("{} aliases an already mounted image", path.display()),
        ));
    }
    // Even a read-only handle must acquire exclusive ownership. Unsupported
    // locking and contention are errors, never reasons for an unlocked fallback.
    file.try_lock().map_err(|error| match error {
        TryLockError::WouldBlock => io::Error::new(
            io::ErrorKind::WouldBlock,
            format!(
                "{} is already locked by another image owner",
                path.display()
            ),
        ),
        TryLockError::Error(error) => io::Error::new(
            error.kind(),
            format!(
                "{} cannot acquire an exclusive image lock: {error}",
                path.display()
            ),
        ),
    })?;
    let file = LockedFile(file);
    let metadata = file.0.metadata()?;
    require_regular(path, &metadata)?;
    if file_identity(&fs::metadata(path)?)? != identity {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} changed identity while acquiring its lock",
                path.display()
            ),
        ));
    }
    let length = metadata.len();
    if length == 0 || !length.is_multiple_of(SECTOR_BYTES as u64) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{} must contain a non-empty whole number of 512-byte sectors",
                path.display()
            ),
        ));
    }
    let sectors = u32::try_from(length / SECTOR_BYTES as u64).map_err(|_| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} exceeds the supported drive size", path.display()),
        )
    })?;
    if sectors.checked_mul(4).is_none() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{} exceeds the 32-bit guest record space", path.display()),
        ));
    }
    Ok(DriveFile {
        path: path.to_owned(),
        file,
        sectors,
        writable,
        identity,
    })
}

impl SectorStore for FileSectorStore {
    fn drive_info(&self, drive: u8) -> Option<DriveInfo> {
        let drive = self.drives.get(usize::from(drive))?.as_ref()?;
        Some(DriveInfo {
            sectors: drive.sectors,
            writable: drive.writable,
        })
    }

    fn read_sector(
        &mut self,
        drive: u8,
        lba: u32,
        output: &mut [u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        let drive = self
            .drives
            .get_mut(usize::from(drive))
            .and_then(Option::as_mut)
            .ok_or(StorageFault)?;
        if lba >= drive.sectors {
            return Err(StorageFault);
        }
        drive
            .file
            .0
            .seek(SeekFrom::Start(u64::from(lba) * SECTOR_BYTES as u64))
            .and_then(|_| drive.file.0.read_exact(output))
            .map_err(|_| StorageFault)
    }

    fn write_sector(
        &mut self,
        drive: u8,
        lba: u32,
        input: &[u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault> {
        let drive = self
            .drives
            .get_mut(usize::from(drive))
            .and_then(Option::as_mut)
            .ok_or(StorageFault)?;
        if !drive.writable || lba >= drive.sectors {
            return Err(StorageFault);
        }
        drive
            .file
            .0
            .seek(SeekFrom::Start(u64::from(lba) * SECTOR_BYTES as u64))
            .and_then(|_| drive.file.0.write_all(input))
            .map_err(|_| StorageFault)
    }

    fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
        self.drives
            .get_mut(usize::from(drive))
            .and_then(Option::as_mut)
            .ok_or(StorageFault)?
            .file
            .0
            .sync_all()
            .map_err(|_| StorageFault)
    }
}
