use crate::SECTOR_BYTES;

pub trait Console {
    /// Return one queued byte without blocking, or `None` when no byte is ready.
    fn receive(&mut self) -> Option<u8>;

    fn transmit(&mut self, byte: u8);

    /// Clear controller-side pending input and undelivered output.
    fn reset(&mut self);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DriveInfo {
    pub sectors: u32,
    pub writable: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StorageFault;

pub trait SectorStore {
    fn drive_info(&self, drive: u8) -> Option<DriveInfo>;

    fn read_sector(
        &mut self,
        drive: u8,
        lba: u32,
        output: &mut [u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault>;

    fn write_sector(
        &mut self,
        drive: u8,
        lba: u32,
        input: &[u8; SECTOR_BYTES],
    ) -> Result<(), StorageFault>;

    /// Complete the provider's durability boundary for one drive.
    fn flush(&mut self, drive: u8) -> Result<(), StorageFault>;
}

pub trait PortTransport {
    fn read(&mut self, offset: u8) -> u8;
    fn write(&mut self, offset: u8, value: u8);
    fn reset(&mut self);
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IoDirection {
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IoOperation {
    pub direction: IoDirection,
    pub port: u16,
    pub value: u8,
}

pub trait IoObserver {
    fn observe(&mut self, operation: IoOperation);
}

pub struct Devices<'a> {
    pub(crate) console: &'a mut dyn Console,
    pub(crate) sectors: &'a mut dyn SectorStore,
    pub(crate) video: Option<&'a mut dyn PortTransport>,
    pub(crate) sound: Option<&'a mut dyn PortTransport>,
    pub(crate) observer: Option<&'a mut dyn IoObserver>,
}

impl<'a> Devices<'a> {
    pub fn new(console: &'a mut dyn Console, sectors: &'a mut dyn SectorStore) -> Self {
        Self {
            console,
            sectors,
            video: None,
            sound: None,
            observer: None,
        }
    }

    pub fn with_video(mut self, video: &'a mut dyn PortTransport) -> Self {
        self.video = Some(video);
        self
    }

    pub fn with_sound(mut self, sound: &'a mut dyn PortTransport) -> Self {
        self.sound = Some(sound);
        self
    }

    pub fn with_observer(mut self, observer: &'a mut dyn IoObserver) -> Self {
        self.observer = Some(observer);
        self
    }

    pub(crate) fn observe(&mut self, operation: IoOperation) {
        if let Some(observer) = self.observer.as_deref_mut() {
            observer.observe(operation);
        }
    }

    pub(crate) fn reset_external_devices(&mut self) {
        self.console.reset();
        if let Some(video) = self.video.as_deref_mut() {
            video.reset();
        }
        if let Some(sound) = self.sound.as_deref_mut() {
            sound.reset();
        }
    }
}
