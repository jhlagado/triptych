//! Copy-only user-0 file access and all-user format migration. This boundary
//! never changes a live CPU drive or publishes browser storage; the host owns
//! that guarded transaction.

use triptych_cpm_image::{CpmGeometry, CpmImage, CpmName, DirectoryFile, FileImport, FreeSpace};
use wasm_bindgen::prelude::*;

struct StagedImport {
    name: String,
    bytes: Vec<u8>,
}

struct DiskFiles {
    source: CpmImage,
    files: Vec<DirectoryFile>,
    free: FreeSpace,
    imports: Vec<StagedImport>,
}

impl DiskFiles {
    fn new(bytes: &[u8]) -> Result<Self, String> {
        let source = CpmImage::from_bytes(bytes.to_vec()).map_err(|e| e.to_string())?;
        Self::from_image(source)
    }

    fn from_image(source: CpmImage) -> Result<Self, String> {
        // Both calls scan every occupied entry, including other users. Recovery
        // of malformed images belongs to whole-image export, not this file API.
        let files = source.files().map_err(|e| e.to_string())?;
        let free = source.free_space().map_err(|e| e.to_string())?;
        Ok(Self {
            source,
            files,
            free,
            imports: Vec::new(),
        })
    }

    fn file(&self, name: &str) -> Result<&DirectoryFile, String> {
        let name = CpmName::parse(name).map_err(|e| e.to_string())?;
        self.files
            .iter()
            .find(|file| file.name == name.canonical())
            .ok_or_else(|| {
                format!(
                    "CP/M disk: file {} does not exist in user 0",
                    name.canonical()
                )
            })
    }

    fn add_import(&mut self, name: &str, bytes: &[u8]) -> Result<String, String> {
        let name = CpmName::parse(name).map_err(|e| e.to_string())?;
        if bytes.is_empty() {
            return Err("CP/M disk: files must contain at least one byte".into());
        }
        if bytes.len() > self.source.as_bytes().len() {
            return Err("CP/M disk: file exceeds disk capacity".into());
        }
        if self.imports.len() >= self.source.geometry().directory_entries() {
            return Err("CP/M disk: batch has more files than directory entries".into());
        }
        if self
            .imports
            .iter()
            .any(|item| item.name == name.canonical())
        {
            return Err(format!("CP/M disk: duplicate import {}", name.canonical()));
        }
        if self
            .files
            .iter()
            .any(|file| file.name == name.canonical() && file.read_only)
        {
            return Err(format!("CP/M disk: {} is read-only", name.canonical()));
        }
        let canonical = name.canonical().to_owned();
        self.imports.push(StagedImport {
            name: canonical.clone(),
            bytes: bytes.to_vec(),
        });
        Ok(canonical)
    }

    fn candidate(&self) -> Result<Vec<u8>, String> {
        let imports: Vec<_> = self
            .imports
            .iter()
            .map(|item| FileImport {
                name: &item.name,
                bytes: &item.bytes,
            })
            .collect();
        self.source
            .install_batch(&imports)
            .map(CpmImage::into_bytes)
            .map_err(|e| e.to_string())
    }

    fn read(&self, name: &str) -> Result<Vec<u8>, String> {
        let file = self.file(name)?;
        self.source
            .read(&file.name)
            .map_err(|e| e.to_string())?
            .map(|file| file.bytes)
            .ok_or_else(|| "CP/M disk: file disappeared".into())
    }

    fn migrate_to(&self, geometry: CpmGeometry, system_area: &[u8]) -> Result<Vec<u8>, String> {
        if !self.imports.is_empty() {
            return Err("Clear staged imports before migrating the disk.".into());
        }
        self.source
            .migrate_to(geometry, system_area)
            .map(CpmImage::into_bytes)
            .map_err(|error| error.to_string())
    }
}

fn js_error(message: String) -> JsError {
    JsError::new(&message)
}

/// Validated supported source image plus a private, all-or-none import batch.
/// Metadata and reads always describe the original image, not staged imports.
/// CP/M files are record-rounded; downloads retain their 128-byte padding.
#[wasm_bindgen]
pub struct CpmDisk {
    disk: DiskFiles,
}

#[wasm_bindgen]
impl CpmDisk {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<CpmDisk, JsError> {
        DiskFiles::new(bytes)
            .map(|disk| Self { disk })
            .map_err(js_error)
    }

    /// Create an independent empty data disk, without CCP, BDOS or BIOS bytes.
    /// This does not mount a drive or publish storage; the host owns that commit.
    pub fn create_eight_mib() -> Result<CpmDisk, JsError> {
        DiskFiles::from_image(CpmImage::blank(CpmGeometry::Triptych8M))
            .map(|disk| Self { disk })
            .map_err(js_error)
    }

    /// Create an independent empty 2 MiB data disk. Its reserved system area
    /// contains zeroes; installing bootable residents is a separate operation.
    pub fn create_two_mib() -> Result<CpmDisk, JsError> {
        DiskFiles::from_image(CpmImage::blank(CpmGeometry::Triptych2M))
            .map(|disk| Self { disk })
            .map_err(js_error)
    }

    pub fn canonical_name(name: &str) -> Result<String, JsError> {
        CpmName::parse(name)
            .map(|name| name.canonical().to_owned())
            .map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn geometry_id(&self) -> String {
        self.disk.source.geometry().id().to_owned()
    }

    /// Return a private 8 MiB candidate with explicitly supplied system bytes.
    /// Migration copies the source, not staged imports. The browser must still
    /// obtain consent, preserve a backup and commit through its coordinator.
    pub fn migrate_to_eight_mib(&self, system_area: &[u8]) -> Result<Vec<u8>, JsError> {
        self.disk
            .migrate_to(CpmGeometry::Triptych8M, system_area)
            .map_err(js_error)
    }

    /// Return a private 2 MiB candidate, preserving every user's files and
    /// attributes. Non-fitting input rejects the whole operation. This neither
    /// publishes the candidate nor replaces the source or a running machine.
    pub fn migrate_to_two_mib(&self, system_area: &[u8]) -> Result<Vec<u8>, JsError> {
        self.disk
            .migrate_to(CpmGeometry::Triptych2M, system_area)
            .map_err(js_error)
    }

    pub fn file_names(&self) -> Vec<String> {
        self.disk
            .files
            .iter()
            .map(|file| file.name.clone())
            .collect()
    }

    pub fn file_records(&self, name: &str) -> Result<u32, JsError> {
        self.disk
            .file(name)
            .map(|file| file.records as u32)
            .map_err(js_error)
    }

    pub fn file_read_only(&self, name: &str) -> Result<bool, JsError> {
        self.disk
            .file(name)
            .map(|file| file.read_only)
            .map_err(js_error)
    }

    pub fn free_bytes(&self) -> u32 {
        self.disk.free.bytes as u32
    }

    pub fn free_directory_entries(&self) -> u32 {
        self.disk.free.directory_entries as u32
    }

    pub fn read_file(&self, name: &str) -> Result<Vec<u8>, JsError> {
        self.disk.read(name).map_err(js_error)
    }

    pub fn export_source(&self) -> Vec<u8> {
        self.disk.source.as_bytes().to_vec()
    }

    /// Stage an owned copy and return its canonical 8.3 name. Invalid imports
    /// do not disturb the existing batch. Capacity is checked at export so all
    /// replacements release their old allocation before any file grows.
    pub fn add_import(&mut self, name: &str, bytes: &[u8]) -> Result<String, JsError> {
        self.disk.add_import(name, bytes).map_err(js_error)
    }

    pub fn clear_imports(&mut self) {
        self.disk.imports.clear();
    }

    pub fn import_count(&self) -> u32 {
        self.disk.imports.len() as u32
    }

    /// Produce a validated candidate without consuming the batch or changing
    /// the source. Publication and replacement consent remain host obligations.
    pub fn export_candidate(&self) -> Result<Vec<u8>, JsError> {
        self.disk.candidate().map_err(js_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use triptych_cpm_image::{BLOCK_BYTES, DIRECTORY_BYTES, SYSTEM_BYTES, WORKING_IMAGE_BYTES};

    fn blank() -> Vec<u8> {
        let mut bytes = vec![0; WORKING_IMAGE_BYTES];
        bytes[SYSTEM_BYTES..SYSTEM_BYTES + DIRECTORY_BYTES].fill(0xe5);
        bytes
    }

    #[test]
    fn public_blank_eight_mib_is_data_only_and_matches_shared_geometry() {
        check_public_blank(
            CpmDisk::create_eight_mib().unwrap(),
            CpmGeometry::Triptych8M,
        );
    }

    #[test]
    fn public_blank_two_mib_is_data_only_and_matches_shared_geometry() {
        check_public_blank(CpmDisk::create_two_mib().unwrap(), CpmGeometry::Triptych2M);
    }

    fn check_public_blank(disk: CpmDisk, geometry: CpmGeometry) {
        let expected = CpmImage::blank(geometry);
        let source = disk.export_source();
        assert_eq!(source, expected.as_bytes());
        assert_eq!(source.len(), geometry.image_bytes());
        assert!(
            source[..geometry.system_bytes()]
                .iter()
                .all(|byte| *byte == 0)
        );
        assert_eq!(disk.geometry_id(), geometry.id());
        assert!(disk.file_names().is_empty());
        assert_eq!(disk.import_count(), 0);
        assert_eq!(
            disk.free_directory_entries() as usize,
            geometry.directory_entries()
        );
        assert_eq!(
            disk.free_bytes() as usize,
            expected.free_space().unwrap().bytes
        );
        assert_eq!(disk.export_candidate().unwrap(), source);
        let reopened = CpmDisk::new(&source).unwrap();
        assert_eq!(reopened.export_source(), source);
        assert_eq!(reopened.geometry_id(), disk.geometry_id());
    }

    #[test]
    fn public_blank_eight_mib_keeps_instances_exports_and_staged_inputs_private() {
        check_private_blank_instances(CpmDisk::create_eight_mib);
    }

    #[test]
    fn public_blank_two_mib_keeps_instances_exports_and_staged_inputs_private() {
        check_private_blank_instances(CpmDisk::create_two_mib);
    }

    fn check_private_blank_instances(create: fn() -> Result<CpmDisk, JsError>) {
        let mut first = create().unwrap();
        let second = create().unwrap();
        let original = second.export_source();
        let mut exported = first.export_source();
        exported.fill(0x55);
        let mut input = vec![0x41; 129];
        assert_eq!(first.add_import("hello.txt", &input).unwrap(), "HELLO.TXT");
        input.fill(0x42);
        assert_eq!(first.import_count(), 1);
        assert!(first.file_names().is_empty());
        assert_eq!(first.export_source(), original);
        assert_eq!(second.export_candidate().unwrap(), original);
        assert_eq!(second.import_count(), 0);
        let candidate = first.export_candidate().unwrap();
        let reopened = CpmDisk::new(&candidate).unwrap();
        assert_eq!(reopened.file_names(), ["HELLO.TXT"]);
        assert_eq!(reopened.file_records("HELLO.TXT").unwrap(), 2);
        let contents = reopened.read_file("HELLO.TXT").unwrap();
        assert_eq!(&contents[..129], &[0x41; 129]);
        assert_eq!(&contents[129..], &[0x1a; 127]);
        let system_bytes = first.disk.source.geometry().system_bytes();
        assert_eq!(&candidate[..system_bytes], &original[..system_bytes]);
        first.clear_imports();
        assert_eq!(first.export_candidate().unwrap(), original);
        assert_eq!(reopened.export_source(), candidate);
    }

    #[test]
    fn copied_source_and_staged_input_match_shared_library_batch() {
        let mut input = blank();
        let original = input.clone();
        let mut disk = DiskFiles::new(&input).unwrap();
        input.fill(0);
        let mut contents = vec![65; 129];
        assert_eq!(
            disk.add_import("hello.txt", &contents).unwrap(),
            "HELLO.TXT"
        );
        contents.fill(66);
        let expected = CpmImage::from_bytes(original.clone())
            .unwrap()
            .install("HELLO.TXT", &[65; 129])
            .unwrap()
            .into_bytes();
        assert_eq!(disk.candidate().unwrap(), expected);
        assert_eq!(disk.candidate().unwrap(), expected);
        assert_eq!(disk.source.as_bytes(), original);
        assert!(disk.files.is_empty());
        assert_eq!(disk.free.bytes, 241 * BLOCK_BYTES);
        let candidate = DiskFiles::new(&expected).unwrap();
        assert_eq!(candidate.file("hello.txt").unwrap().records, 2);
        assert_eq!(&candidate.read("hello.txt").unwrap()[129..], &[0x1a; 127]);
    }

    #[test]
    fn large_format_stages_more_than_legacy_directory_capacity() {
        let image = CpmImage::blank(CpmGeometry::Triptych8M);
        let mut disk = DiskFiles::new(image.as_bytes()).unwrap();
        for number in 0..65 {
            disk.add_import(&format!("F{number:03}.NU"), &[number as u8])
                .unwrap();
        }
        let candidate = DiskFiles::new(&disk.candidate().unwrap()).unwrap();
        assert_eq!(candidate.files.len(), 65);
        assert_eq!(candidate.source.geometry(), CpmGeometry::Triptych8M);
        assert_eq!(candidate.read("F064.NU").unwrap()[0], 64);
        assert_eq!(disk.source.as_bytes(), image.as_bytes());
    }

    #[test]
    fn migration_is_explicit_immutable_and_rejects_a_pending_batch() {
        for geometry in [CpmGeometry::Triptych2M, CpmGeometry::Triptych8M] {
            check_migration(geometry);
        }
    }

    fn check_migration(geometry: CpmGeometry) {
        let image = CpmImage::from_bytes(blank())
            .unwrap()
            .install("INPUT.NU", b"sub main()\r\nend\r\n")
            .unwrap();
        let mut disk = DiskFiles::new(image.as_bytes()).unwrap();
        let system = vec![0x52; geometry.system_bytes()];
        assert!(disk.migrate_to(geometry, &system[..128]).is_err());
        let result = disk.migrate_to(geometry, &system).unwrap();
        let migrated = DiskFiles::new(&result).unwrap();
        assert_eq!(
            migrated.read("INPUT.NU").unwrap(),
            disk.read("INPUT.NU").unwrap()
        );
        assert_eq!(&result[..system.len()], &system);
        assert_eq!(migrated.source.geometry(), geometry);
        assert_eq!(disk.source.as_bytes(), image.as_bytes());
        disk.add_import("OTHER.NU", b"pending").unwrap();
        assert!(disk.migrate_to(geometry, &system).is_err());
        assert_eq!(disk.imports.len(), 1);
        assert_eq!(disk.source.as_bytes(), image.as_bytes());
    }

    #[test]
    fn non_fitting_two_mib_migration_keeps_source_and_all_files() {
        let image = CpmImage::blank(CpmGeometry::Triptych8M)
            .install("LARGE.BIN", &vec![0x59; 2_048_000 + 128])
            .unwrap();
        let disk = DiskFiles::new(image.as_bytes()).unwrap();
        let system = vec![0x52; CpmGeometry::Triptych2M.system_bytes()];
        let error = disk
            .migrate_to(CpmGeometry::Triptych2M, &system)
            .unwrap_err();
        assert!(error.contains("insufficient capacity"));
        assert_eq!(disk.source, image);
        assert!(disk.imports.is_empty());
        assert_eq!(disk.candidate().unwrap(), image.as_bytes());
    }

    #[test]
    fn invalid_staging_leaves_prior_batch_and_source_unchanged() {
        let original = blank();
        let mut disk = DiskFiles::new(&original).unwrap();
        disk.add_import("GOOD.NU", &[65]).unwrap();
        let candidate = disk.candidate().unwrap();
        for (name, bytes) in [
            ("bad/name.nu", &[1][..]),
            ("EMPTY", &[][..]),
            ("good.nu", &[2][..]),
        ] {
            assert!(disk.add_import(name, bytes).is_err());
        }
        assert_eq!(disk.imports.len(), 1);
        assert_eq!(disk.candidate().unwrap(), candidate);
        assert_eq!(disk.source.as_bytes(), original);
        assert!(disk.read("MISSING").is_err());
    }

    #[test]
    fn read_only_and_invalid_directory_are_rejected() {
        let mut bytes = CpmImage::from_bytes(blank())
            .unwrap()
            .install("LOCK.COM", &[7])
            .unwrap()
            .into_bytes();
        bytes[SYSTEM_BYTES + 9] |= 0x80;
        let mut disk = DiskFiles::new(&bytes).unwrap();
        assert!(disk.file("LOCK.COM").unwrap().read_only);
        assert!(
            disk.add_import("LOCK.COM", &[8])
                .unwrap_err()
                .contains("read-only")
        );
        assert_eq!(disk.candidate().unwrap(), bytes);
        bytes[SYSTEM_BYTES + 16] = 1;
        assert!(DiskFiles::new(&bytes).is_err());
        assert!(DiskFiles::new(&[0; 512]).is_err());
    }

    #[test]
    fn all_replacements_release_space_before_allocation_and_failed_export_is_atomic() {
        let image = CpmImage::from_bytes(blank())
            .unwrap()
            .install_batch(&[
                FileImport {
                    name: "A.BIN",
                    bytes: &vec![1; BLOCK_BYTES],
                },
                FileImport {
                    name: "B.BIN",
                    bytes: &vec![2; 240 * BLOCK_BYTES],
                },
            ])
            .unwrap();
        let mut disk = DiskFiles::new(image.as_bytes()).unwrap();
        disk.add_import("A.BIN", &vec![3; 240 * BLOCK_BYTES])
            .unwrap();
        assert!(disk.candidate().is_err());
        assert_eq!(disk.source, image);
        disk.add_import("B.BIN", &vec![4; BLOCK_BYTES]).unwrap();
        let result = DiskFiles::new(&disk.candidate().unwrap()).unwrap();
        assert_eq!(result.read("A.BIN").unwrap(), vec![3; 240 * BLOCK_BYTES]);
        assert_eq!(result.read("B.BIN").unwrap(), vec![4; BLOCK_BYTES]);
        assert_eq!(disk.source, image);
    }
}
