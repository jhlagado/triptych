//! CP/M 2.2 filesystem operations for Triptych's ideal IBM 3740 disk image.
//!
//! This crate deliberately works with named files and complete disk images.
//! The guest-visible logical-record controller remains owned by
//! `triptych-cpu-core`.

use std::error::Error;
use std::fmt;

pub const DISK_IMAGE_BYTES: usize = 77 * 26 * RECORD_BYTES;
pub const WORKING_IMAGE_BYTES: usize =
    DISK_IMAGE_BYTES.div_ceil(BACKING_SECTOR_BYTES) * BACKING_SECTOR_BYTES;
pub const SYSTEM_BYTES: usize = 2 * 26 * RECORD_BYTES;
pub const DIRECTORY_ENTRIES: usize = 64;
pub const DIRECTORY_ENTRY_BYTES: usize = 32;
pub const DIRECTORY_BYTES: usize = DIRECTORY_ENTRIES * DIRECTORY_ENTRY_BYTES;
pub const BLOCK_BYTES: usize = 1024;
pub const BLOCK_COUNT: usize = 243;
pub const RESERVED_BLOCKS: usize = 2;
pub const RECORD_BYTES: usize = 128;
pub const RECORDS_PER_EXTENT: usize = 128;
pub const BLOCKS_PER_EXTENT: usize = 16;
pub const BACKING_SECTOR_BYTES: usize = 512;

const DIRECTORY_FREE: u8 = 0xe5;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CpmError(String);

impl CpmError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for CpmError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "CP/M disk: {}", self.0)
    }
}

impl Error for CpmError {}

pub type Result<T> = std::result::Result<T, CpmError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CpmName {
    canonical: String,
    name: [u8; 8],
    extension: [u8; 3],
}

impl CpmName {
    pub fn parse(source: &str) -> Result<Self> {
        let canonical = source.trim().to_ascii_uppercase();
        let mut parts = canonical.split('.');
        let name = parts.next().unwrap_or_default();
        let extension = parts.next().unwrap_or_default();
        if parts.next().is_some()
            || name.is_empty()
            || name.len() > 8
            || extension.len() > 3
            || canonical.ends_with('.')
            || !name.bytes().all(valid_filename_byte)
            || !extension.bytes().all(valid_filename_byte)
        {
            return Err(CpmError::new(format!("invalid filename {source:?}")));
        }
        let mut padded_name = [b' '; 8];
        padded_name[..name.len()].copy_from_slice(name.as_bytes());
        let mut padded_extension = [b' '; 3];
        padded_extension[..extension.len()].copy_from_slice(extension.as_bytes());
        Ok(Self {
            canonical: if extension.is_empty() {
                name.to_owned()
            } else {
                format!("{name}.{extension}")
            },
            name: padded_name,
            extension: padded_extension,
        })
    }

    pub fn canonical(&self) -> &str {
        &self.canonical
    }
}

fn valid_filename_byte(byte: u8) -> bool {
    byte.is_ascii_uppercase() || byte.is_ascii_digit() || b"_$#@!%&'()-^{}~".contains(&byte)
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DirectoryFile {
    pub name: String,
    pub records: usize,
}

impl DirectoryFile {
    pub fn stored_bytes(&self) -> usize {
        self.records * RECORD_BYTES
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FreeSpace {
    pub allocation_blocks: usize,
    pub bytes: usize,
    pub directory_entries: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredFile {
    pub name: String,
    pub records: usize,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CpmImage {
    bytes: Vec<u8>,
}

impl CpmImage {
    /// Accepts either the canonical 256,256-byte IBM 3740 image or the
    /// 256,512-byte form padded to Triptych's 512-byte host-sector boundary.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self> {
        if bytes.len() != DISK_IMAGE_BYTES && bytes.len() != WORKING_IMAGE_BYTES {
            return Err(CpmError::new(format!(
                "image must contain exactly {DISK_IMAGE_BYTES} bytes or the {WORKING_IMAGE_BYTES}-byte Triptych working-image form"
            )));
        }
        Ok(Self { bytes })
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.bytes
    }

    /// Returns a native-host-ready image without changing any logical CP/M
    /// record. The extra half sector is inaccessible to the IBM 3740 DPB.
    pub fn into_working_bytes(mut self) -> Vec<u8> {
        self.bytes.resize(WORKING_IMAGE_BYTES, 0);
        self.bytes
    }

    pub fn files(&self) -> Result<Vec<DirectoryFile>> {
        let scan = self.scan_directory()?;
        validate_extent_sequences(&scan.files)?;
        scan.files
            .iter()
            .map(|file| {
                Ok(DirectoryFile {
                    name: file.name.clone(),
                    records: file.extents.iter().try_fold(0_usize, |total, extent| {
                        total.checked_add(extent.records).ok_or_else(|| {
                            CpmError::new(format!("{} record count overflows", file.name))
                        })
                    })?,
                })
            })
            .collect()
    }

    pub fn free_space(&self) -> Result<FreeSpace> {
        let scan = self.scan_directory()?;
        validate_extent_sequences(&scan.files)?;
        let allocation_blocks = (RESERVED_BLOCKS..BLOCK_COUNT)
            .filter(|block| !scan.used_blocks[*block])
            .count();
        Ok(FreeSpace {
            allocation_blocks,
            bytes: allocation_blocks * BLOCK_BYTES,
            directory_entries: scan.free_entries.len(),
        })
    }

    /// Returns a replacement image. `self` is unchanged on every failure.
    pub fn install(&self, filename_source: &str, contents: &[u8]) -> Result<Self> {
        if contents.is_empty() {
            return Err(CpmError::new("files must contain at least one byte"));
        }
        let filename = CpmName::parse(filename_source)?;
        let records = contents.len().div_ceil(RECORD_BYTES);
        let extent_count = records.div_ceil(RECORDS_PER_EXTENT);
        let block_count = records.div_ceil(BLOCK_BYTES / RECORD_BYTES);
        let mut scan = self.scan_directory()?;
        validate_extent_sequences(&scan.files)?;
        let replaced = scan
            .files
            .iter()
            .find(|file| file.name == filename.canonical)
            .map(|file| file.extents.clone())
            .unwrap_or_default();
        let mut image = self.clone();

        for extent in &replaced {
            image.clear_entry(extent.entry_index);
            for &block in &extent.blocks {
                image.clear_block(block);
                scan.used_blocks[block] = false;
            }
        }

        let mut available_entries: Vec<_> =
            replaced.iter().map(|extent| extent.entry_index).collect();
        available_entries.extend(scan.free_entries.iter().copied());
        if available_entries.len() < extent_count {
            return Err(CpmError::new(format!(
                "directory has no room for {}",
                filename.canonical
            )));
        }
        let available_blocks: Vec<_> = (RESERVED_BLOCKS..BLOCK_COUNT)
            .filter(|block| !scan.used_blocks[*block])
            .collect();
        if available_blocks.len() < block_count {
            return Err(CpmError::new(format!(
                "disk has no room for {}",
                filename.canonical
            )));
        }

        let mut padded = vec![0x1a; records * RECORD_BYTES];
        padded[..contents.len()].copy_from_slice(contents);
        let mut record_cursor = 0;
        let mut block_cursor = 0;
        for (extent_index, entry_index) in available_entries
            .iter()
            .copied()
            .take(extent_count)
            .enumerate()
        {
            let extent_records = RECORDS_PER_EXTENT.min(records.saturating_sub(record_cursor));
            let extent_blocks = extent_records.div_ceil(BLOCK_BYTES / RECORD_BYTES);
            let blocks = &available_blocks[block_cursor..block_cursor + extent_blocks];
            image.write_extent(entry_index, &filename, extent_index, extent_records, blocks)?;
            for &block in blocks {
                let offset = block_offset(block);
                image.bytes[offset..offset + BLOCK_BYTES].fill(DIRECTORY_FREE);
                let source_offset = record_cursor * RECORD_BYTES;
                let length = BLOCK_BYTES.min(padded.len() - source_offset);
                image.bytes[offset..offset + length]
                    .copy_from_slice(&padded[source_offset..source_offset + length]);
                record_cursor += length / RECORD_BYTES;
            }
            block_cursor += extent_blocks;
        }
        Ok(image)
    }

    /// Reads the record-padded bytes of one user-0 file.
    pub fn read(&self, filename_source: &str) -> Result<Option<StoredFile>> {
        let filename = CpmName::parse(filename_source)?;
        let scan = self.scan_directory()?;
        validate_extent_sequences(&scan.files)?;
        let Some(file) = scan
            .files
            .iter()
            .find(|file| file.name == filename.canonical)
        else {
            return Ok(None);
        };
        let mut extents = file.extents.clone();
        extents.sort_by_key(|extent| extent.extent);
        let records = extents.iter().map(|extent| extent.records).sum::<usize>();
        let mut bytes = Vec::with_capacity(records * RECORD_BYTES);
        for extent in extents {
            let mut remaining = extent.records * RECORD_BYTES;
            for block in extent.blocks {
                let length = remaining.min(BLOCK_BYTES);
                let offset = block_offset(block);
                bytes.extend_from_slice(&self.bytes[offset..offset + length]);
                remaining -= length;
            }
        }
        Ok(Some(StoredFile {
            name: filename.canonical,
            records,
            bytes,
        }))
    }

    fn scan_directory(&self) -> Result<DirectoryScan> {
        let mut free_entries = Vec::new();
        let mut used_blocks = [false; BLOCK_COUNT];
        let mut files: Vec<ScannedFile> = Vec::new();
        for entry_index in 0..DIRECTORY_ENTRIES {
            let entry = entry_offset(entry_index);
            let user = self.bytes[entry];
            if user == DIRECTORY_FREE {
                free_entries.push(entry_index);
                continue;
            }
            if user > 15 {
                return Err(CpmError::new(format!(
                    "directory entry {entry_index} has invalid user {user}"
                )));
            }
            let extent = self.read_extent(entry_index)?;
            for &block in &extent.blocks {
                if used_blocks[block] {
                    return Err(CpmError::new(format!(
                        "allocation block {block} is referenced more than once"
                    )));
                }
                used_blocks[block] = true;
            }
            if user == 0 {
                let name = self.entry_filename(entry);
                if let Some(file) = files.iter_mut().find(|file| file.name == name) {
                    file.extents.push(extent);
                } else {
                    files.push(ScannedFile {
                        name,
                        extents: vec![extent],
                    });
                }
            }
        }
        Ok(DirectoryScan {
            free_entries,
            used_blocks,
            files,
        })
    }

    fn read_extent(&self, entry_index: usize) -> Result<DirectoryExtent> {
        let entry = entry_offset(entry_index);
        let records = usize::from(self.bytes[entry + 15]);
        if records > RECORDS_PER_EXTENT {
            return Err(CpmError::new(format!(
                "directory entry {entry_index} has invalid record count {records}"
            )));
        }
        let extent =
            usize::from(self.bytes[entry + 12] & 0x1f) | (usize::from(self.bytes[entry + 14]) << 5);
        let block_count = records.div_ceil(BLOCK_BYTES / RECORD_BYTES);
        let mut blocks = Vec::with_capacity(block_count);
        for index in 0..block_count {
            let block = usize::from(self.bytes[entry + 16 + index]);
            if !(RESERVED_BLOCKS..BLOCK_COUNT).contains(&block) {
                return Err(CpmError::new(format!(
                    "directory entry {entry_index} references invalid block {block}"
                )));
            }
            blocks.push(block);
        }
        Ok(DirectoryExtent {
            entry_index,
            extent,
            records,
            blocks,
        })
    }

    fn entry_filename(&self, entry: usize) -> String {
        fn decode(bytes: &[u8]) -> String {
            let mut decoded: Vec<_> = bytes.iter().map(|byte| byte & 0x7f).collect();
            while decoded.last() == Some(&b' ') {
                decoded.pop();
            }
            String::from_utf8_lossy(&decoded).into_owned()
        }
        let name = decode(&self.bytes[entry + 1..entry + 9]);
        let extension = decode(&self.bytes[entry + 9..entry + 12]);
        if extension.is_empty() {
            name
        } else {
            format!("{name}.{extension}")
        }
    }

    fn clear_entry(&mut self, entry_index: usize) {
        let entry = entry_offset(entry_index);
        self.bytes[entry..entry + DIRECTORY_ENTRY_BYTES].fill(DIRECTORY_FREE);
    }

    fn clear_block(&mut self, block: usize) {
        let offset = block_offset(block);
        self.bytes[offset..offset + BLOCK_BYTES].fill(DIRECTORY_FREE);
    }

    fn write_extent(
        &mut self,
        entry_index: usize,
        filename: &CpmName,
        extent_index: usize,
        records: usize,
        blocks: &[usize],
    ) -> Result<()> {
        let entry = entry_offset(entry_index);
        self.bytes[entry..entry + DIRECTORY_ENTRY_BYTES].fill(0);
        self.bytes[entry + 1..entry + 9].copy_from_slice(&filename.name);
        self.bytes[entry + 9..entry + 12].copy_from_slice(&filename.extension);
        self.bytes[entry + 12] = u8::try_from(extent_index & 0x1f)
            .map_err(|_| CpmError::new("extent number overflow"))?;
        self.bytes[entry + 14] =
            u8::try_from(extent_index >> 5).map_err(|_| CpmError::new("extent number overflow"))?;
        self.bytes[entry + 15] =
            u8::try_from(records).map_err(|_| CpmError::new("extent record count overflow"))?;
        for (index, block) in blocks.iter().enumerate() {
            self.bytes[entry + 16 + index] =
                u8::try_from(*block).map_err(|_| CpmError::new("allocation block overflow"))?;
        }
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct DirectoryExtent {
    entry_index: usize,
    extent: usize,
    records: usize,
    blocks: Vec<usize>,
}

#[derive(Debug)]
struct ScannedFile {
    name: String,
    extents: Vec<DirectoryExtent>,
}

#[derive(Debug)]
struct DirectoryScan {
    free_entries: Vec<usize>,
    used_blocks: [bool; BLOCK_COUNT],
    files: Vec<ScannedFile>,
}

fn validate_extent_sequences(files: &[ScannedFile]) -> Result<()> {
    for file in files {
        let mut extents: Vec<_> = file.extents.iter().map(|extent| extent.extent).collect();
        extents.sort_unstable();
        for (expected, actual) in extents.into_iter().enumerate() {
            if actual != expected {
                return Err(CpmError::new(format!(
                    "{} has a missing or duplicate extent",
                    file.name
                )));
            }
        }
    }
    Ok(())
}

fn entry_offset(entry_index: usize) -> usize {
    SYSTEM_BYTES + entry_index * DIRECTORY_ENTRY_BYTES
}

fn block_offset(block: usize) -> usize {
    SYSTEM_BYTES + block * BLOCK_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank_image() -> CpmImage {
        CpmImage::from_bytes(vec![DIRECTORY_FREE; DISK_IMAGE_BYTES]).unwrap()
    }

    fn bytes(length: usize, seed: u8) -> Vec<u8> {
        (0..length)
            .map(|index| seed.wrapping_add(index as u8))
            .collect()
    }

    #[test]
    fn canonicalizes_supported_names() {
        let name = CpmName::parse("hello-1.$#@").unwrap();
        assert_eq!(name.canonical(), "HELLO-1.$#@");
        for invalid in [
            "",
            "TOO-LONG9.COM",
            "MAIN.TOOLONG",
            "A/B.COM",
            ".COM",
            "MAIN.",
        ] {
            assert!(CpmName::parse(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn installs_one_record_without_changing_source_or_system_tracks() {
        let mut source_bytes = vec![DIRECTORY_FREE; DISK_IMAGE_BYTES];
        source_bytes[..SYSTEM_BYTES].fill(0x5a);
        let source = CpmImage::from_bytes(source_bytes).unwrap();
        let before = source.clone();
        let contents = bytes(17, 0x20);
        let result = source.install("main.com", &contents).unwrap();

        assert_eq!(source, before);
        assert!(result.as_bytes()[..SYSTEM_BYTES]
            .iter()
            .all(|byte| *byte == 0x5a));
        assert_eq!(result.files().unwrap()[0].name, "MAIN.COM");
        let file = result.read("MAIN.COM").unwrap().unwrap();
        assert_eq!(file.records, 1);
        assert_eq!(&file.bytes[..contents.len()], contents);
        assert!(file.bytes[contents.len()..]
            .iter()
            .all(|byte| *byte == 0x1a));
    }

    #[test]
    fn writes_multiple_blocks_and_extents() {
        let contents = bytes(58_112, 0x31);
        let result = blank_image().install("LARGE.COM", &contents).unwrap();
        let file = result.read("large.com").unwrap().unwrap();

        assert_eq!(file.records, contents.len() / RECORD_BYTES);
        assert_eq!(file.bytes, contents);
        assert_eq!(result.files().unwrap()[0].name, "LARGE.COM");
    }

    #[test]
    fn replaces_all_extents_atomically_and_retains_other_files() {
        let first = blank_image()
            .install("OTHER.TXT", &bytes(33, 0x70))
            .unwrap();
        let old = first.install("MAIN.COM", &bytes(20_000, 0x11)).unwrap();
        let before = old.clone();
        let replacement = bytes(253, 0x91);
        let result = old.install("main.com", &replacement).unwrap();

        assert_eq!(old, before);
        assert_eq!(
            result
                .files()
                .unwrap()
                .into_iter()
                .map(|file| file.name)
                .collect::<Vec<_>>(),
            ["OTHER.TXT", "MAIN.COM"]
        );
        assert_eq!(
            &result.read("OTHER.TXT").unwrap().unwrap().bytes[..33],
            bytes(33, 0x70)
        );
        assert_eq!(
            &result.read("MAIN.COM").unwrap().unwrap().bytes[..replacement.len()],
            replacement
        );
    }

    #[test]
    fn rejects_capacity_failures_without_changing_source() {
        let almost_full = blank_image()
            .install("FILL.BIN", &bytes(239 * BLOCK_BYTES, 0x10))
            .unwrap();
        let before = almost_full.clone();
        assert!(almost_full
            .install("MAIN.COM", &bytes(3 * BLOCK_BYTES, 0x20))
            .unwrap_err()
            .to_string()
            .contains("disk has no room"));
        assert_eq!(almost_full, before);

        let mut directory_full = blank_image();
        for index in 0..DIRECTORY_ENTRIES {
            directory_full = directory_full
                .install(&format!("F{index}.BIN"), &[index as u8])
                .unwrap();
        }
        let before = directory_full.clone();
        assert!(directory_full.install("EXTRA.BIN", &[1]).is_err());
        assert_eq!(directory_full, before);
    }

    #[test]
    fn reports_free_space_and_preserves_native_padding() {
        let mut bytes = vec![DIRECTORY_FREE; WORKING_IMAGE_BYTES];
        bytes[DISK_IMAGE_BYTES..].fill(0x7b);
        let image = CpmImage::from_bytes(bytes)
            .unwrap()
            .install("ONE.BIN", &[1])
            .unwrap();
        let free = image.free_space().unwrap();

        assert_eq!(free.allocation_blocks, BLOCK_COUNT - RESERVED_BLOCKS - 1);
        assert_eq!(free.directory_entries, DIRECTORY_ENTRIES - 1);
        assert!(image.as_bytes()[DISK_IMAGE_BYTES..]
            .iter()
            .all(|byte| *byte == 0x7b));
    }

    #[test]
    fn rejects_duplicate_allocation_references() {
        let image = blank_image().install("ONE.BIN", &[1]).unwrap();
        let mut bytes = image.into_bytes();
        let directory = SYSTEM_BYTES;
        bytes.copy_within(directory..directory + DIRECTORY_ENTRY_BYTES, directory + 32);
        bytes[directory + 33] = b'T';
        let malformed = CpmImage::from_bytes(bytes).unwrap();

        assert!(malformed
            .files()
            .unwrap_err()
            .to_string()
            .contains("allocation block 2 is referenced more than once"));
    }
}
