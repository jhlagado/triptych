use crate::{DriveInfo, SectorStore, RECORD_BYTES, SECTOR_BYTES};

const RECORDS_PER_SECTOR: u32 = (SECTOR_BYTES / RECORD_BYTES) as u32;

const COMMAND_STATUS: u8 = 0x10;
const DRIVE: u8 = 0x11;
const RECORD_0: u8 = 0x12;
const RECORD_1: u8 = 0x13;
const RECORD_2: u8 = 0x14;
const RECORD_3: u8 = 0x15;
const DATA: u8 = 0x16;
const ERROR: u8 = 0x17;

const COMMAND_READ: u8 = 1;
const COMMAND_WRITE: u8 = 2;
const COMMAND_FLUSH: u8 = 3;
const COMMAND_CAPACITY: u8 = 4;

const ERROR_NONE: u8 = 0;
const ERROR_DRIVE: u8 = 1;
const ERROR_RECORD: u8 = 2;
const ERROR_COMMAND: u8 = 3;
const ERROR_PROTOCOL: u8 = 4;
const ERROR_WRITE_PROTECTED: u8 = 5;
const ERROR_PROVIDER: u8 = 6;

const STATUS_DATA_REQUEST: u8 = 1 << 1;
const STATUS_ERROR: u8 = 1 << 2;
const STATUS_WRITE_PROTECTED: u8 = 1 << 3;
const STATUS_MEDIA_PRESENT: u8 = 1 << 4;
const STATUS_DIRTY: u8 = 1 << 5;
const STATUS_READY: u8 = 1 << 6;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TransferKind {
    Read,
    Write,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiskState {
    pub drive: u8,
    pub record: u32,
    pub error: u8,
    pub transfer_position: Option<u8>,
    pub cache_drive: Option<u8>,
    pub cache_sector: Option<u32>,
    pub cache_dirty: bool,
}

pub(crate) struct Controller {
    selected_drive: u8,
    selected_record: u32,
    error: u8,
    transfer_kind: Option<TransferKind>,
    transfer_position: usize,
    transfer_offset: usize,
    transfer_bytes: [u8; RECORD_BYTES],
    cache_valid: bool,
    cache_drive: u8,
    cache_sector: u32,
    cache_dirty: bool,
    cache_bytes: [u8; SECTOR_BYTES],
}

impl Default for Controller {
    fn default() -> Self {
        Self {
            selected_drive: 0,
            selected_record: 0,
            error: ERROR_NONE,
            transfer_kind: None,
            transfer_position: 0,
            transfer_offset: 0,
            transfer_bytes: [0; RECORD_BYTES],
            cache_valid: false,
            cache_drive: 0,
            cache_sector: 0,
            cache_dirty: false,
            cache_bytes: [0; SECTOR_BYTES],
        }
    }
}

impl Controller {
    pub(crate) fn reset(&mut self) {
        self.selected_drive = 0;
        self.selected_record = 0;
        self.error = ERROR_NONE;
        self.abort_transfer();
    }

    pub(crate) fn state(&self) -> DiskState {
        DiskState {
            drive: self.selected_drive,
            record: self.selected_record,
            error: self.error,
            transfer_position: self.transfer_kind.map(|_| self.transfer_position as u8),
            cache_drive: self.cache_valid.then_some(self.cache_drive),
            cache_sector: self.cache_valid.then_some(self.cache_sector),
            cache_dirty: self.cache_dirty,
        }
    }

    pub(crate) fn read_port(&mut self, port: u8, sectors: &mut dyn SectorStore) -> u8 {
        match port {
            COMMAND_STATUS => self.status(sectors),
            DRIVE => self.selected_drive,
            RECORD_0 => self.selected_record as u8,
            RECORD_1 => (self.selected_record >> 8) as u8,
            RECORD_2 => (self.selected_record >> 16) as u8,
            RECORD_3 => (self.selected_record >> 24) as u8,
            DATA => self.read_data(),
            ERROR => self.error,
            _ => 0,
        }
    }

    pub(crate) fn write_port(&mut self, port: u8, value: u8, sectors: &mut dyn SectorStore) {
        match port {
            COMMAND_STATUS => self.begin_command(value, sectors),
            DRIVE => self.update_selection(|controller| {
                controller.selected_drive = value;
            }),
            RECORD_0 => self.update_selection(|controller| {
                controller.selected_record =
                    (controller.selected_record & 0xffff_ff00) | u32::from(value);
            }),
            RECORD_1 => self.update_selection(|controller| {
                controller.selected_record =
                    (controller.selected_record & 0xffff_00ff) | (u32::from(value) << 8);
            }),
            RECORD_2 => self.update_selection(|controller| {
                controller.selected_record =
                    (controller.selected_record & 0xff00_ffff) | (u32::from(value) << 16);
            }),
            RECORD_3 => self.update_selection(|controller| {
                controller.selected_record =
                    (controller.selected_record & 0x00ff_ffff) | (u32::from(value) << 24);
            }),
            DATA => self.write_data(value),
            _ => {}
        }
    }

    fn status(&self, sectors: &dyn SectorStore) -> u8 {
        let drive = sectors.drive_info(self.selected_drive);
        STATUS_READY
            | if self.transfer_kind.is_some() {
                STATUS_DATA_REQUEST
            } else {
                0
            }
            | if self.error != ERROR_NONE {
                STATUS_ERROR
            } else {
                0
            }
            | if drive.is_some() {
                STATUS_MEDIA_PRESENT
            } else {
                0
            }
            | if drive.is_some_and(|info| !info.writable) {
                STATUS_WRITE_PROTECTED
            } else {
                0
            }
            | if self.cache_dirty { STATUS_DIRTY } else { 0 }
    }

    fn abort_transfer(&mut self) {
        self.transfer_kind = None;
        self.transfer_position = 0;
    }

    fn fail(&mut self, error: u8) {
        self.abort_transfer();
        self.error = error;
    }

    fn drive_and_capacity(&mut self, sectors: &dyn SectorStore) -> Option<(DriveInfo, u32)> {
        let Some(info) = sectors.drive_info(self.selected_drive) else {
            self.fail(ERROR_DRIVE);
            return None;
        };
        let Some(records) = info.sectors.checked_mul(RECORDS_PER_SECTOR) else {
            self.fail(ERROR_PROVIDER);
            return None;
        };
        Some((info, records))
    }

    fn validate_record(&mut self, sectors: &dyn SectorStore) -> Option<DriveInfo> {
        let (info, records) = self.drive_and_capacity(sectors)?;
        if self.selected_record >= records {
            self.fail(ERROR_RECORD);
            return None;
        }
        Some(info)
    }

    fn flush_cache(&mut self, sectors: &mut dyn SectorStore) -> bool {
        if !self.cache_valid || !self.cache_dirty {
            return true;
        }
        if sectors
            .write_sector(self.cache_drive, self.cache_sector, &self.cache_bytes)
            .is_err()
        {
            self.fail(ERROR_PROVIDER);
            return false;
        }
        self.cache_dirty = false;
        true
    }

    fn select_cache(&mut self, sectors: &mut dyn SectorStore) -> bool {
        let sector = self.selected_record / RECORDS_PER_SECTOR;
        if self.cache_valid
            && self.cache_drive == self.selected_drive
            && self.cache_sector == sector
        {
            return true;
        }
        if !self.flush_cache(sectors) {
            return false;
        }

        let mut bytes = [0; SECTOR_BYTES];
        if sectors
            .read_sector(self.selected_drive, sector, &mut bytes)
            .is_err()
        {
            self.fail(ERROR_PROVIDER);
            return false;
        }
        self.cache_bytes = bytes;
        self.cache_drive = self.selected_drive;
        self.cache_sector = sector;
        self.cache_valid = true;
        self.cache_dirty = false;
        true
    }

    fn begin_command(&mut self, command: u8, sectors: &mut dyn SectorStore) {
        self.abort_transfer();
        self.error = ERROR_NONE;
        match command {
            COMMAND_READ => self.begin_read(sectors),
            COMMAND_WRITE => self.begin_write(sectors),
            COMMAND_FLUSH => {
                if self.flush_cache(sectors) && sectors.flush(self.selected_drive).is_err() {
                    self.fail(ERROR_PROVIDER);
                }
            }
            COMMAND_CAPACITY => {
                if let Some((_, records)) = self.drive_and_capacity(sectors) {
                    self.selected_record = records;
                }
            }
            _ => self.fail(ERROR_COMMAND),
        }
    }

    fn begin_read(&mut self, sectors: &mut dyn SectorStore) {
        if self.validate_record(sectors).is_none() || !self.select_cache(sectors) {
            return;
        }
        self.error = ERROR_NONE;
        let offset = self.record_offset();
        self.transfer_bytes
            .copy_from_slice(&self.cache_bytes[offset..offset + RECORD_BYTES]);
        self.transfer_kind = Some(TransferKind::Read);
        self.transfer_position = 0;
        self.transfer_offset = offset;
    }

    fn begin_write(&mut self, sectors: &mut dyn SectorStore) {
        let Some(info) = self.validate_record(sectors) else {
            return;
        };
        if !info.writable {
            self.fail(ERROR_WRITE_PROTECTED);
            return;
        }
        if !self.select_cache(sectors) {
            return;
        }
        self.error = ERROR_NONE;
        self.transfer_bytes.fill(0);
        self.transfer_kind = Some(TransferKind::Write);
        self.transfer_position = 0;
        self.transfer_offset = self.record_offset();
    }

    fn record_offset(&self) -> usize {
        (self.selected_record % RECORDS_PER_SECTOR) as usize * RECORD_BYTES
    }

    fn read_data(&mut self) -> u8 {
        if self.transfer_kind != Some(TransferKind::Read) {
            self.fail(ERROR_PROTOCOL);
            return 0;
        }
        let value = self.transfer_bytes[self.transfer_position];
        self.transfer_position += 1;
        if self.transfer_position == RECORD_BYTES {
            self.abort_transfer();
        }
        value
    }

    fn write_data(&mut self, value: u8) {
        if self.transfer_kind != Some(TransferKind::Write) {
            self.fail(ERROR_PROTOCOL);
            return;
        }
        self.transfer_bytes[self.transfer_position] = value;
        self.transfer_position += 1;
        if self.transfer_position != RECORD_BYTES {
            return;
        }
        if !self.cache_valid {
            self.fail(ERROR_PROTOCOL);
            return;
        }
        let offset = self.transfer_offset;
        self.cache_bytes[offset..offset + RECORD_BYTES].copy_from_slice(&self.transfer_bytes);
        self.cache_dirty = true;
        self.abort_transfer();
    }

    fn update_selection(&mut self, update: impl FnOnce(&mut Self)) {
        if self.transfer_kind.is_some() {
            self.fail(ERROR_PROTOCOL);
        }
        update(self);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{StorageFault, SECTOR_BYTES};

    struct Store {
        bytes: [u8; SECTOR_BYTES * 2],
        writable: bool,
        fail_reads: bool,
    }

    impl Default for Store {
        fn default() -> Self {
            Self {
                bytes: [0; SECTOR_BYTES * 2],
                writable: true,
                fail_reads: false,
            }
        }
    }

    impl SectorStore for Store {
        fn drive_info(&self, drive: u8) -> Option<DriveInfo> {
            (drive == 0).then_some(DriveInfo {
                sectors: 2,
                writable: self.writable,
            })
        }

        fn read_sector(
            &mut self,
            drive: u8,
            lba: u32,
            output: &mut [u8; SECTOR_BYTES],
        ) -> Result<(), StorageFault> {
            if drive != 0 || lba >= 2 || self.fail_reads {
                return Err(StorageFault);
            }
            let start = lba as usize * SECTOR_BYTES;
            output.copy_from_slice(&self.bytes[start..start + SECTOR_BYTES]);
            Ok(())
        }

        fn write_sector(
            &mut self,
            drive: u8,
            lba: u32,
            input: &[u8; SECTOR_BYTES],
        ) -> Result<(), StorageFault> {
            if drive != 0 || lba >= 2 || !self.writable {
                return Err(StorageFault);
            }
            let start = lba as usize * SECTOR_BYTES;
            self.bytes[start..start + SECTOR_BYTES].copy_from_slice(input);
            Ok(())
        }

        fn flush(&mut self, drive: u8) -> Result<(), StorageFault> {
            if drive == 0 {
                Ok(())
            } else {
                Err(StorageFault)
            }
        }
    }

    #[test]
    fn all_record_quarters_are_addressed_and_other_bytes_survive_flush() {
        let mut store = Store::default();
        for quarter in 0..4 {
            store.bytes[quarter * RECORD_BYTES..(quarter + 1) * RECORD_BYTES].fill(quarter as u8);
        }
        let original = store.bytes;
        let mut controller = Controller::default();

        for record in 0..4_u32 {
            select_record(&mut controller, &mut store, record);
            controller.write_port(COMMAND_STATUS, COMMAND_READ, &mut store);
            for _ in 0..RECORD_BYTES {
                assert_eq!(controller.read_port(DATA, &mut store), record as u8);
            }
        }

        select_record(&mut controller, &mut store, 2);
        controller.write_port(COMMAND_STATUS, COMMAND_WRITE, &mut store);
        for _ in 0..RECORD_BYTES {
            controller.write_port(DATA, 0xaa, &mut store);
        }
        assert_eq!(store.bytes, original);
        controller.write_port(COMMAND_STATUS, COMMAND_FLUSH, &mut store);
        assert_eq!(
            &store.bytes[..RECORD_BYTES * 2],
            &original[..RECORD_BYTES * 2]
        );
        assert_eq!(
            &store.bytes[RECORD_BYTES * 2..RECORD_BYTES * 3],
            &[0xaa; RECORD_BYTES]
        );
        assert_eq!(
            &store.bytes[RECORD_BYTES * 3..SECTOR_BYTES],
            &original[RECORD_BYTES * 3..SECTOR_BYTES]
        );
    }

    #[test]
    fn reset_discards_a_partial_write_but_retains_a_complete_dirty_record() {
        let mut store = Store::default();
        store.bytes.fill(0x11);
        let original = store.bytes;
        let mut controller = Controller::default();

        controller.write_port(COMMAND_STATUS, COMMAND_WRITE, &mut store);
        for _ in 0..RECORD_BYTES - 1 {
            controller.write_port(DATA, 0x22, &mut store);
        }
        controller.reset();
        controller.write_port(COMMAND_STATUS, COMMAND_FLUSH, &mut store);
        assert_eq!(store.bytes, original);

        controller.write_port(COMMAND_STATUS, COMMAND_WRITE, &mut store);
        for _ in 0..RECORD_BYTES {
            controller.write_port(DATA, 0x33, &mut store);
        }
        assert!(controller.state().cache_dirty);
        controller.reset();
        assert!(controller.state().cache_dirty);
        controller.write_port(COMMAND_STATUS, COMMAND_FLUSH, &mut store);
        assert_eq!(&store.bytes[..RECORD_BYTES], &[0x33; RECORD_BYTES]);
    }

    #[test]
    fn bounds_protection_and_provider_failures_have_distinct_guest_errors() {
        let mut store = Store::default();
        let mut controller = Controller::default();

        select_record(&mut controller, &mut store, 8);
        controller.write_port(COMMAND_STATUS, COMMAND_READ, &mut store);
        assert_eq!(controller.read_port(ERROR, &mut store), ERROR_RECORD);

        select_record(&mut controller, &mut store, 0);
        store.writable = false;
        controller.write_port(COMMAND_STATUS, COMMAND_WRITE, &mut store);
        assert_eq!(
            controller.read_port(ERROR, &mut store),
            ERROR_WRITE_PROTECTED
        );

        store.writable = true;
        store.fail_reads = true;
        controller.write_port(COMMAND_STATUS, COMMAND_READ, &mut store);
        assert_eq!(controller.read_port(ERROR, &mut store), ERROR_PROVIDER);
    }

    fn select_record(controller: &mut Controller, store: &mut Store, record: u32) {
        controller.write_port(RECORD_0, record as u8, store);
        controller.write_port(RECORD_1, (record >> 8) as u8, store);
        controller.write_port(RECORD_2, (record >> 16) as u8, store);
        controller.write_port(RECORD_3, (record >> 24) as u8, store);
    }
}
