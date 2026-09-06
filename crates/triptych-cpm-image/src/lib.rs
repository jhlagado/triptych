//! CP/M 2.2 filesystem operations for Triptych's closed disk profiles.
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

/// Supported EXM=0 disk layouts. Image length selects a candidate, not validity.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CpmGeometry {
    Ibm3740,
    Triptych2M,
    Triptych8M,
}

impl CpmGeometry {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Ibm3740 => "ibm3740",
            Self::Triptych2M => "triptych-cpm-2m-v1",
            Self::Triptych8M => "triptych-cpm-8m-v1",
        }
    }
    pub const fn image_bytes(self) -> usize {
        match self {
            Self::Ibm3740 => DISK_IMAGE_BYTES,
            Self::Triptych2M => 2 * 1024 * 1024,
            Self::Triptych8M => 8 * 1024 * 1024,
        }
    }
    pub const fn working_bytes(self) -> usize {
        match self {
            Self::Ibm3740 => WORKING_IMAGE_BYTES,
            Self::Triptych2M | Self::Triptych8M => self.image_bytes(),
        }
    }
    pub const fn system_bytes(self) -> usize {
        match self {
            Self::Ibm3740 => SYSTEM_BYTES,
            Self::Triptych2M | Self::Triptych8M => 16384,
        }
    }
    pub const fn directory_entries(self) -> usize {
        match self {
            Self::Ibm3740 => DIRECTORY_ENTRIES,
            Self::Triptych2M => 1024,
            Self::Triptych8M => 512,
        }
    }
    const fn block_bytes(self) -> usize {
        match self {
            Self::Ibm3740 => BLOCK_BYTES,
            Self::Triptych2M | Self::Triptych8M => 2048,
        }
    }
    const fn block_count(self) -> usize {
        match self {
            Self::Ibm3740 => BLOCK_COUNT,
            Self::Triptych2M => 1016,
            Self::Triptych8M => 4088,
        }
    }
    const fn reserved_blocks(self) -> usize {
        match self {
            Self::Ibm3740 => RESERVED_BLOCKS,
            Self::Triptych2M => 16,
            Self::Triptych8M => 8,
        }
    }
    const fn allocation_width(self) -> usize {
        match self {
            Self::Ibm3740 => 1,
            Self::Triptych2M | Self::Triptych8M => 2,
        }
    }
    const fn blocks_per_extent(self) -> usize {
        16 / self.allocation_width()
    }
    const fn entry_offset(self, index: usize) -> usize {
        self.system_bytes() + index * DIRECTORY_ENTRY_BYTES
    }
    const fn block_offset(self, block: usize) -> usize {
        self.system_bytes() + block * self.block_bytes()
    }
}

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
        let canonical = source.to_ascii_uppercase();
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
    pub read_only: bool,
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

/// One user-0 file in an immutable, all-or-none installation batch.
pub struct FileImport<'a> {
    pub name: &'a str,
    pub bytes: &'a [u8],
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CpmImage {
    bytes: Vec<u8>,
    geometry: CpmGeometry,
}

impl CpmImage {
    /// Accepts either legacy length or an exact 2 MiB or 8 MiB profile length.
    /// Directory validation is separate so malformed images remain recoverable.
    pub fn from_bytes(bytes: Vec<u8>) -> Result<Self> {
        let geometry = match bytes.len() {
            DISK_IMAGE_BYTES | WORKING_IMAGE_BYTES => CpmGeometry::Ibm3740,
            2_097_152 => CpmGeometry::Triptych2M,
            8_388_608 => CpmGeometry::Triptych8M,
            _ => {
                return Err(CpmError::new(
                    "disk image must be exactly 256256, 256512, 2097152 or 8388608 bytes",
                ))
            }
        };
        Ok(Self { bytes, geometry })
    }

    pub fn geometry(&self) -> CpmGeometry {
        self.geometry
    }

    /// Creates an empty canonical image, with zeroed (not bootable) system records.
    pub fn blank(geometry: CpmGeometry) -> Self {
        let mut bytes = vec![DIRECTORY_FREE; geometry.image_bytes()];
        bytes[..geometry.system_bytes()].fill(0);
        Self { bytes, geometry }
    }

    /// Builds a new image, preserving every user's record-rounded file contents
    /// and per-extent attributes. The complete target system area is explicit;
    /// this operation does not establish that its resident software is compatible.
    pub fn migrate_to(&self, geometry: CpmGeometry, system_bytes: &[u8]) -> Result<Self> {
        if system_bytes.len() != geometry.system_bytes() {
            return Err(CpmError::new(
                "migration requires the complete target system area",
            ));
        }
        let source = self.scan_directory()?;
        let mut target = Self::blank(geometry);
        target.bytes[..system_bytes.len()].copy_from_slice(system_bytes);
        let mut next_entry = 0;
        let mut next_block = geometry.reserved_blocks();
        for file in &source.files {
            let filename = CpmName::parse(&file.name)?;
            for extent in &file.extents {
                let count = extent
                    .records
                    .div_ceil(geometry.block_bytes() / RECORD_BYTES);
                if next_entry >= geometry.directory_entries()
                    || next_block + count > geometry.block_count()
                {
                    return Err(CpmError::new("migration target has insufficient capacity"));
                }
                let blocks: Vec<_> = (next_block..next_block + count).collect();
                target.write_extent(
                    next_entry,
                    &filename,
                    extent.extent,
                    extent.records,
                    &blocks,
                )?;
                let from = self.geometry.entry_offset(extent.entry_index);
                let to = geometry.entry_offset(next_entry);
                // User, name attributes, extent identity and RC remain exact.
                target.bytes[to..to + 16].copy_from_slice(&self.bytes[from..from + 16]);
                let contents = self.read_extent_bytes(extent);
                for (index, block) in blocks.into_iter().enumerate() {
                    let offset = geometry.block_offset(block);
                    let start = index * geometry.block_bytes();
                    let length = geometry.block_bytes().min(contents.len() - start);
                    target.bytes[offset..offset + length]
                        .copy_from_slice(&contents[start..start + length]);
                }
                next_entry += 1;
                next_block += count;
            }
        }
        target.validate()?;
        Ok(target)
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
        self.bytes.resize(self.geometry.working_bytes(), 0);
        self.bytes
    }

    pub fn files(&self) -> Result<Vec<DirectoryFile>> {
        let scan = self.scan_directory()?;
        scan.files
            .iter()
            .filter(|file| file.user == 0)
            .map(|file| {
                Ok(DirectoryFile {
                    name: file.name.clone(),
                    read_only: file.read_only,
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
        let allocation_blocks = (self.geometry.reserved_blocks()..self.geometry.block_count())
            .filter(|block| !scan.used_blocks[*block])
            .count();
        Ok(FreeSpace {
            allocation_blocks,
            bytes: allocation_blocks * self.geometry.block_bytes(),
            directory_entries: scan.free_entries.len(),
        })
    }

    /// Returns a replacement image. `self` is unchanged on every failure.
    pub fn install(&self, filename_source: &str, contents: &[u8]) -> Result<Self> {
        self.install_batch(&[FileImport {
            name: filename_source,
            bytes: contents,
        }])
    }

    /// Validates every occupied entry, including other users, before use.
    /// Sparse files and non-contiguous extent sequences are unsupported and
    /// rejected rather than shortened or repaired. Raw image loading itself
    /// checks only geometry, so malformed images remain exportable for recovery.
    pub fn validate(&self) -> Result<()> {
        self.scan_directory().map(|_| ())
    }

    /// Returns a private replacement image, never a partly installed batch.
    /// Canonically duplicate names, empty files and read-only replacements
    /// are errors. All replaced files release their capacity before allocation,
    /// so batch success does not depend on whether growing files come first.
    pub fn install_batch(&self, imports: &[FileImport<'_>]) -> Result<Self> {
        let mut scan = self.scan_directory()?;
        if imports.len() > self.geometry.directory_entries() {
            return Err(CpmError::new("batch has more files than directory entries"));
        }
        let mut names = Vec::with_capacity(imports.len());
        for import in imports {
            let name = CpmName::parse(import.name)?;
            if import.bytes.is_empty() {
                return Err(CpmError::new("files must contain at least one byte"));
            }
            if names.contains(&name) {
                return Err(CpmError::new(format!(
                    "duplicate import {}",
                    name.canonical
                )));
            }
            names.push(name);
        }
        let mut image = self.clone();
        for file in scan
            .files
            .iter()
            .filter(|file| file.user == 0 && names.iter().any(|name| name.canonical == file.name))
        {
            if file.read_only {
                return Err(CpmError::new(format!("{} is read-only", file.name)));
            }
            for extent in &file.extents {
                image.clear_entry(extent.entry_index);
                scan.free_entries.push(extent.entry_index);
                for &block in &extent.blocks {
                    image.clear_block(block);
                    scan.used_blocks[block] = false;
                }
            }
        }
        scan.free_entries.sort_unstable();
        for (name, import) in names.iter().zip(imports) {
            let mut attributed = name.clone();
            if let Some(previous) = scan
                .files
                .iter()
                .find(|file| file.user == 0 && file.name == name.canonical)
            {
                // Preserve existing CP/M attribute bits when replacing bytes.
                // Read-only was checked across all extents above.
                let entry = self.geometry.entry_offset(previous.extents[0].entry_index);
                for (index, byte) in attributed.name.iter_mut().enumerate() {
                    *byte |= self.bytes[entry + 1 + index] & 0x80;
                }
                for (index, byte) in attributed.extension.iter_mut().enumerate() {
                    *byte |= self.bytes[entry + 9 + index] & 0x80;
                }
            }
            image.install_new(&attributed, import.bytes, &mut scan)?;
        }
        Ok(image)
    }

    fn install_new(
        &mut self,
        filename: &CpmName,
        contents: &[u8],
        scan: &mut DirectoryScan,
    ) -> Result<()> {
        let records = contents.len().div_ceil(RECORD_BYTES);
        let extent_count = records.div_ceil(RECORDS_PER_EXTENT);
        let geometry = self.geometry;
        let block_count = records.div_ceil(geometry.block_bytes() / RECORD_BYTES);
        if scan.free_entries.len() < extent_count {
            return Err(CpmError::new(format!(
                "directory has no room for {}",
                filename.canonical
            )));
        }
        let available_blocks: Vec<_> = (geometry.reserved_blocks()..geometry.block_count())
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
        for (extent_index, entry_index) in scan
            .free_entries
            .iter()
            .copied()
            .take(extent_count)
            .enumerate()
        {
            let extent_records = RECORDS_PER_EXTENT.min(records.saturating_sub(record_cursor));
            let extent_blocks = extent_records.div_ceil(geometry.block_bytes() / RECORD_BYTES);
            let blocks = &available_blocks[block_cursor..block_cursor + extent_blocks];
            self.write_extent(entry_index, filename, extent_index, extent_records, blocks)?;
            for &block in blocks {
                let offset = geometry.block_offset(block);
                self.bytes[offset..offset + geometry.block_bytes()].fill(DIRECTORY_FREE);
                let source_offset = record_cursor * RECORD_BYTES;
                let length = geometry.block_bytes().min(padded.len() - source_offset);
                self.bytes[offset..offset + length]
                    .copy_from_slice(&padded[source_offset..source_offset + length]);
                scan.used_blocks[block] = true;
                record_cursor += length / RECORD_BYTES;
            }
            block_cursor += extent_blocks;
        }
        scan.free_entries.drain(..extent_count);
        Ok(())
    }

    /// Reads the record-padded bytes of one user-0 file.
    pub fn read(&self, filename_source: &str) -> Result<Option<StoredFile>> {
        let filename = CpmName::parse(filename_source)?;
        let scan = self.scan_directory()?;
        let Some(file) = scan
            .files
            .iter()
            .find(|file| file.user == 0 && file.name == filename.canonical)
        else {
            return Ok(None);
        };
        let mut extents = file.extents.clone();
        extents.sort_by_key(|extent| extent.extent);
        let records = extents.iter().map(|extent| extent.records).sum::<usize>();
        let mut bytes = Vec::with_capacity(records * RECORD_BYTES);
        for extent in extents {
            bytes.extend_from_slice(&self.read_extent_bytes(&extent));
        }
        Ok(Some(StoredFile {
            name: filename.canonical,
            records,
            bytes,
        }))
    }

    fn read_extent_bytes(&self, extent: &DirectoryExtent) -> Vec<u8> {
        let mut remaining = extent.records * RECORD_BYTES;
        let mut bytes = Vec::with_capacity(remaining);
        for &block in &extent.blocks {
            let length = remaining.min(self.geometry.block_bytes());
            let offset = self.geometry.block_offset(block);
            bytes.extend_from_slice(&self.bytes[offset..offset + length]);
            remaining -= length;
        }
        bytes
    }

    fn scan_directory(&self) -> Result<DirectoryScan> {
        let mut free_entries = Vec::new();
        let mut used_blocks = vec![false; self.geometry.block_count()];
        let mut files: Vec<ScannedFile> = Vec::new();
        for entry_index in 0..self.geometry.directory_entries() {
            let entry = self.geometry.entry_offset(entry_index);
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
            let name = self.entry_filename(entry)?;
            let read_only = self.bytes[entry + 9] & 0x80 != 0;
            if let Some(file) = files
                .iter_mut()
                .find(|file| file.user == user && file.name == name)
            {
                file.extents.push(extent);
                file.read_only |= read_only;
            } else {
                files.push(ScannedFile {
                    user,
                    name,
                    read_only,
                    extents: vec![extent],
                });
            }
        }
        validate_extent_sequences(&files)?;
        Ok(DirectoryScan {
            free_entries,
            used_blocks,
            files,
        })
    }

    fn read_extent(&self, entry_index: usize) -> Result<DirectoryExtent> {
        let entry = self.geometry.entry_offset(entry_index);
        let records = usize::from(self.bytes[entry + 15]);
        if records > RECORDS_PER_EXTENT {
            return Err(CpmError::new(format!(
                "directory entry {entry_index} has invalid record count {records}"
            )));
        }
        if self.bytes[entry + 12] > 0x1f || self.bytes[entry + 14] > 0x0f {
            return Err(CpmError::new(format!(
                "directory entry {entry_index} has invalid extent bits"
            )));
        }
        let extent =
            usize::from(self.bytes[entry + 12]) | (usize::from(self.bytes[entry + 14]) << 5);
        let geometry = self.geometry;
        let block_count = records.div_ceil(geometry.block_bytes() / RECORD_BYTES);
        let mut blocks = Vec::with_capacity(geometry.blocks_per_extent());
        for index in 0..geometry.blocks_per_extent() {
            let offset = entry + 16 + index * geometry.allocation_width();
            let block = if geometry.allocation_width() == 2 {
                usize::from(u16::from_le_bytes([
                    self.bytes[offset],
                    self.bytes[offset + 1],
                ]))
            } else {
                usize::from(self.bytes[offset])
            };
            if block == 0 {
                if index >= block_count {
                    continue;
                }
                return Err(CpmError::new(format!(
                    "directory entry {entry_index} has an unsupported sparse allocation"
                )));
            }
            if !(geometry.reserved_blocks()..geometry.block_count()).contains(&block) {
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

    fn entry_filename(&self, entry: usize) -> Result<String> {
        fn decode(bytes: &[u8]) -> String {
            let mut decoded: Vec<_> = bytes.iter().map(|byte| byte & 0x7f).collect();
            while decoded.last() == Some(&b' ') {
                decoded.pop();
            }
            String::from_utf8_lossy(&decoded).into_owned()
        }
        let name = decode(&self.bytes[entry + 1..entry + 9]);
        let extension = decode(&self.bytes[entry + 9..entry + 12]);
        let decoded = if extension.is_empty() {
            name
        } else {
            format!("{name}.{extension}")
        };
        let parsed = CpmName::parse(&decoded)?;
        if parsed.canonical != decoded
            || self.bytes[entry + 1..entry + 9]
                .iter()
                .zip(parsed.name)
                .any(|(actual, expected)| actual & 0x7f != expected)
            || self.bytes[entry + 9..entry + 12]
                .iter()
                .zip(parsed.extension)
                .any(|(actual, expected)| actual & 0x7f != expected)
        {
            return Err(CpmError::new(format!(
                "non-canonical directory filename {decoded:?}"
            )));
        }
        Ok(decoded)
    }

    fn clear_entry(&mut self, entry_index: usize) {
        let entry = self.geometry.entry_offset(entry_index);
        self.bytes[entry..entry + DIRECTORY_ENTRY_BYTES].fill(DIRECTORY_FREE);
    }

    fn clear_block(&mut self, block: usize) {
        let offset = self.geometry.block_offset(block);
        self.bytes[offset..offset + self.geometry.block_bytes()].fill(DIRECTORY_FREE);
    }

    fn write_extent(
        &mut self,
        entry_index: usize,
        filename: &CpmName,
        extent_index: usize,
        records: usize,
        blocks: &[usize],
    ) -> Result<()> {
        let entry = self.geometry.entry_offset(entry_index);
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
            let offset = entry + 16 + index * self.geometry.allocation_width();
            if self.geometry.allocation_width() == 2 {
                self.bytes[offset..offset + 2].copy_from_slice(
                    &u16::try_from(*block)
                        .map_err(|_| CpmError::new("allocation block overflow"))?
                        .to_le_bytes(),
                );
            } else {
                self.bytes[offset] =
                    u8::try_from(*block).map_err(|_| CpmError::new("allocation block overflow"))?;
            }
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
    user: u8,
    name: String,
    read_only: bool,
    extents: Vec<DirectoryExtent>,
}

#[derive(Debug)]
struct DirectoryScan {
    free_entries: Vec<usize>,
    used_blocks: Vec<bool>,
    files: Vec<ScannedFile>,
}

fn validate_extent_sequences(files: &[ScannedFile]) -> Result<()> {
    for file in files {
        let mut extents: Vec<_> = file.extents.iter().collect();
        extents.sort_unstable_by_key(|extent| extent.extent);
        for (expected, actual) in extents.iter().enumerate() {
            if actual.extent != expected {
                return Err(CpmError::new(format!(
                    "{} has a missing or duplicate extent (sparse files are unsupported)",
                    file.name
                )));
            }
            if expected + 1 < extents.len() && actual.records != RECORDS_PER_EXTENT {
                return Err(CpmError::new(format!(
                    "{} has an unsupported short non-final extent",
                    file.name
                )));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
fn entry_offset(entry_index: usize) -> usize {
    SYSTEM_BYTES + entry_index * DIRECTORY_ENTRY_BYTES
}

#[cfg(test)]
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
            " MAIN.COM",
            "MAIN.COM ",
            "A B.COM",
            "*.COM",
            "A?.COM",
            "A:MAIN.COM",
            "£.COM",
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

    #[test]
    fn rejects_read_only_replacement() {
        let mut image = blank_image().install("ONE.BIN", &[1]).unwrap();
        image.bytes[entry_offset(0) + 9] |= 0x80;
        let before = image.clone();
        assert!(image.install("ONE.BIN", &[2]).is_err());
        assert_eq!(image, before);
        assert_eq!(image.read("ONE.BIN").unwrap().unwrap().bytes[0], 1);
        assert!(image.files().unwrap()[0].read_only);
    }

    #[test]
    fn reserves_all_allocation_pointers_in_other_users() {
        let mut image = blank_image().install("OTHER.BIN", &[1]).unwrap();
        image.bytes[entry_offset(0)] = 7;
        image.bytes[entry_offset(0) + 17] = 3;
        image.bytes[block_offset(3)..block_offset(4)].fill(0x7a);
        let before = image.clone();
        let installed = image.install("NEW.BIN", &[2]).unwrap();
        assert_eq!(
            &installed.bytes[block_offset(3)..block_offset(4)],
            &before.bytes[block_offset(3)..block_offset(4)]
        );
        assert_eq!(installed.bytes[entry_offset(1) + 16], 4);
    }

    #[test]
    fn rejects_malformed_other_user_extents_and_names() {
        let base = blank_image().install("OTHER.BIN", &[1]).unwrap();
        for (field, value) in [(12, 1), (1, b'?'), (2, b' ')] {
            let mut image = base.clone();
            image.bytes[entry_offset(0)] = 7;
            image.bytes[entry_offset(0) + field] = value;
            assert!(image.files().is_err(), "accepted field {field}");
            assert!(image.read("MISSING.BIN").is_err());
            assert!(image.install("NEW.BIN", &[2]).is_err());
        }
    }

    fn assert_rejected_everywhere(image: &CpmImage) {
        let before = image.clone();
        assert!(image.validate().is_err());
        assert!(image.files().is_err());
        assert!(image.free_space().is_err());
        assert!(image.read("MISSING.BIN").is_err());
        assert!(image.install("NEW.BIN", &[1]).is_err());
        assert_eq!(image, &before);
    }

    #[test]
    fn rejects_allocation_corruption_even_outside_record_count() {
        let base = blank_image().install("ONE.BIN", &[1]).unwrap();
        for (field, value) in [
            (16, 0),
            (16, 1),
            (16, 243),
            (17, 1),
            (31, 243),
            (31, 2),
            (15, 129),
        ] {
            let mut image = base.clone();
            image.bytes[entry_offset(0) + field] = value;
            assert_rejected_everywhere(&image);
        }
        let mut image = base.install("TWO.BIN", &[2]).unwrap();
        image.bytes[entry_offset(1)] = 8;
        image.bytes[entry_offset(1) + 31] = 2;
        assert_rejected_everywhere(&image);
    }

    #[test]
    fn rejects_duplicate_missing_and_short_non_final_extents_for_every_user() {
        let base = blank_image().install("BIG.BIN", &bytes(17_000, 3)).unwrap();
        for user in [0, 15] {
            for (entry, field, value) in [
                (1, 12, 0),
                (1, 12, 2),
                (0, 15, 127),
                (0, 12, 0x20),
                (0, 14, 0x80),
            ] {
                let mut image = base.clone();
                image.bytes[entry_offset(0)] = user;
                image.bytes[entry_offset(1)] = user;
                image.bytes[entry_offset(entry) + field] = value;
                assert_rejected_everywhere(&image);
            }
        }
    }

    #[test]
    fn read_only_on_later_extent_blocks_replacement() {
        let mut image = blank_image().install("BIG.BIN", &bytes(17_000, 3)).unwrap();
        image.bytes[entry_offset(1) + 9] |= 0x80;
        assert!(image.files().unwrap()[0].read_only);
        assert!(image
            .install("BIG.BIN", &[2])
            .unwrap_err()
            .to_string()
            .contains("read-only"));
    }

    #[test]
    fn preserves_other_users_system_tracks_padding_and_file_attributes() {
        let mut image = blank_image()
            .install("SAME.BIN", &bytes(1700, 0x30))
            .unwrap();
        image.bytes[entry_offset(0)] = 15;
        image.bytes[..SYSTEM_BYTES].fill(0x75);
        image.bytes.resize(WORKING_IMAGE_BYTES, 0x69);
        let mut image = image.install("SAME.BIN", &[1]).unwrap();
        image.bytes[entry_offset(1) + 10] |= 0x80;
        image.bytes[entry_offset(1) + 1] |= 0x80;
        let before = image.clone();
        let result = image.install("same.bin", &[7]).unwrap();
        assert_eq!(image, before);
        assert_eq!(
            &result.bytes[..entry_offset(1)],
            &before.bytes[..entry_offset(1)]
        );
        assert_eq!(
            &result.bytes[block_offset(2)..block_offset(4)],
            &before.bytes[block_offset(2)..block_offset(4)]
        );
        assert_eq!(
            &result.bytes[DISK_IMAGE_BYTES..],
            &before.bytes[DISK_IMAGE_BYTES..]
        );
        assert_eq!(result.bytes[entry_offset(1) + 10] & 0x80, 0x80);
        assert_eq!(result.bytes[entry_offset(1) + 1] & 0x80, 0x80);
        assert_eq!(result.files().unwrap().len(), 1);
        assert_eq!(result.read("SAME.BIN").unwrap().unwrap().bytes[0], 7);
    }

    #[test]
    fn supports_existing_empty_files_but_rejects_empty_imports() {
        let mut image = blank_image().install("EMPTY.TXT", &[1]).unwrap();
        image.bytes[entry_offset(0) + 15] = 0;
        image.bytes[entry_offset(0) + 16] = 0;
        assert_eq!(image.read("EMPTY.TXT").unwrap().unwrap().bytes, []);
        assert_eq!(image.files().unwrap()[0].records, 0);
        assert!(image.install("NEW.TXT", &[]).is_err());
    }

    #[test]
    fn batch_failures_never_publish_earlier_imports() {
        let image = blank_image().install("KEEP.BIN", &[9]).unwrap();
        let large = bytes(BLOCK_COUNT * BLOCK_BYTES, 1);
        for (name, contents) in [
            ("TOO-LONG9.BIN", &[1][..]),
            ("EMPTY.BIN", &[][..]),
            ("BIG.BIN", large.as_slice()),
            ("first.bin", &[2][..]),
        ] {
            let before = image.clone();
            let result = image.install_batch(&[
                FileImport {
                    name: "FIRST.BIN",
                    bytes: &[3],
                },
                FileImport {
                    name,
                    bytes: contents,
                },
            ]);
            assert!(result.is_err(), "accepted {name}");
            assert_eq!(image, before);
            assert!(image.read("FIRST.BIN").unwrap().is_none());
        }
    }

    #[test]
    fn batch_releases_all_replacements_before_allocating() {
        let image = blank_image()
            .install("GROW.BIN", &bytes(BLOCK_BYTES, 1))
            .unwrap()
            .install("SHRINK.BIN", &bytes(240 * BLOCK_BYTES, 2))
            .unwrap();
        assert_eq!(image.free_space().unwrap().allocation_blocks, 0);
        assert!(image
            .install("GROW.BIN", &bytes(240 * BLOCK_BYTES, 3))
            .is_err());
        let before = image.clone();
        let grow = bytes(240 * BLOCK_BYTES, 3);
        let shrink = bytes(BLOCK_BYTES, 4);
        let result = image
            .install_batch(&[
                FileImport {
                    name: "GROW.BIN",
                    bytes: &grow,
                },
                FileImport {
                    name: "SHRINK.BIN",
                    bytes: &shrink,
                },
            ])
            .unwrap();
        assert_eq!(image, before);
        assert_eq!(result.read("GROW.BIN").unwrap().unwrap().bytes, grow);
        assert_eq!(result.read("SHRINK.BIN").unwrap().unwrap().bytes, shrink);
        assert_eq!(result.free_space().unwrap().allocation_blocks, 0);
    }

    #[test]
    fn batch_directory_and_read_only_failures_leave_source_identical() {
        let mut image = blank_image();
        for index in 0..DIRECTORY_ENTRIES - 1 {
            image = image.install(&format!("F{index}.BIN"), &[1]).unwrap();
        }
        let before = image.clone();
        let full = image
            .install_batch(&[
                FileImport {
                    name: "FIRST.BIN",
                    bytes: &[2],
                },
                FileImport {
                    name: "SECOND.BIN",
                    bytes: &[3],
                },
            ])
            .unwrap_err();
        assert!(full.to_string().contains("directory has no room"));
        assert_eq!(image, before);

        image.bytes[entry_offset(1) + 9] |= 0x80;
        let before = image.clone();
        let read_only = image
            .install_batch(&[
                FileImport {
                    name: "F0.BIN",
                    bytes: &[4],
                },
                FileImport {
                    name: "F1.BIN",
                    bytes: &[5],
                },
            ])
            .unwrap_err();
        assert!(read_only.to_string().contains("read-only"));
        assert_eq!(image, before);
    }

    #[test]
    fn accepts_last_block_and_ignores_deleted_entry_contents() {
        let mut image = blank_image().install("LAST.BIN", &[1]).unwrap();
        image.bytes[entry_offset(0) + 16] = (BLOCK_COUNT - 1) as u8;
        image.bytes[block_offset(BLOCK_COUNT - 1)] = 0x67;
        image.bytes[entry_offset(1)..entry_offset(2)].fill(0xff);
        image.bytes[entry_offset(1)] = DIRECTORY_FREE;
        assert_eq!(image.read("LAST.BIN").unwrap().unwrap().bytes[0], 0x67);
        let result = image.install("NEW.BIN", &[2]).unwrap();
        assert_eq!(result.bytes[block_offset(BLOCK_COUNT - 1)], 0x67);
    }

    #[test]
    fn rejects_dot_inside_physical_name_field() {
        let mut image = blank_image().install("A", &[1]).unwrap();
        image.bytes[entry_offset(0) + 2] = b'.';
        image.bytes[entry_offset(0) + 3] = b'B';
        assert_rejected_everywhere(&image);
    }
}
