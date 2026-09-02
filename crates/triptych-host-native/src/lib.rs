use std::collections::VecDeque;
use std::fs::{File, OpenOptions};
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

struct DriveFile {
    path: PathBuf,
    file: File,
    sectors: u32,
    writable: bool,
}

pub struct FileSectorStore {
    drives: Vec<DriveFile>,
}

impl FileSectorStore {
    pub fn open(paths: &[PathBuf]) -> io::Result<Self> {
        let mut drives = Vec::with_capacity(paths.len());
        for path in paths {
            drives.push(open_drive(path)?);
        }
        Ok(Self { drives })
    }

    pub fn path(&self, drive: u8) -> Option<&Path> {
        self.drives
            .get(usize::from(drive))
            .map(|entry| entry.path.as_path())
    }
}

fn open_drive(path: &Path) -> io::Result<DriveFile> {
    let (file, writable) = match OpenOptions::new().read(true).write(true).open(path) {
        Ok(file) => (file, true),
        Err(write_error) => match OpenOptions::new().read(true).open(path) {
            Ok(file) => (file, false),
            Err(_) => return Err(write_error),
        },
    };
    let length = file.metadata()?.len();
    if length == 0 || length % SECTOR_BYTES as u64 != 0 {
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
    })
}

impl SectorStore for FileSectorStore {
    fn drive_info(&self, drive: u8) -> Option<DriveInfo> {
        let drive = self.drives.get(usize::from(drive))?;
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
            .ok_or(StorageFault)?;
        if lba >= drive.sectors {
            return Err(StorageFault);
        }
        drive
            .file
            .seek(SeekFrom::Start(u64::from(lba) * SECTOR_BYTES as u64))
            .and_then(|_| drive.file.read_exact(output))
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
            .ok_or(StorageFault)?;
        if !drive.writable || lba >= drive.sectors {
            return Err(StorageFault);
        }
        drive
            .file
            .seek(SeekFrom::Start(u64::from(lba) * SECTOR_BYTES as u64))
            .and_then(|_| drive.file.write_all(input))
            .map_err(|_| StorageFault)
    }

    fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
        self.drives
            .get_mut(usize::from(drive))
            .ok_or(StorageFault)?
            .file
            .sync_all()
            .map_err(|_| StorageFault)
    }
}
