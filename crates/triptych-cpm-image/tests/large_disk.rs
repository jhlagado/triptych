use triptych_cpm_image::{
    CpmGeometry, CpmImage, FileImport, DISK_IMAGE_BYTES, SYSTEM_BYTES, WORKING_IMAGE_BYTES,
};

const LARGE: CpmGeometry = CpmGeometry::Triptych8M;
const SYSTEM: usize = 16_384;
const BLOCK: usize = 2048;

fn read_user(image: &CpmImage, user: u8, name: &str) -> Vec<u8> {
    let mut bytes = image.as_bytes().to_vec();
    let geometry = image.geometry();
    for index in 0..geometry.directory_entries() {
        let offset = geometry.system_bytes() + index * 32;
        if bytes[offset] == user {
            bytes[offset] = 0;
        } else {
            bytes[offset] = 0xe5;
        }
    }
    CpmImage::from_bytes(bytes)
        .unwrap()
        .read(name)
        .unwrap()
        .unwrap()
        .bytes
}

fn metadata(image: &CpmImage) -> Vec<Vec<u8>> {
    let geometry = image.geometry();
    let mut entries: Vec<_> = (0..geometry.directory_entries())
        .filter_map(|index| {
            let offset = geometry.system_bytes() + index * 32;
            (image.as_bytes()[offset] != 0xe5)
                .then(|| image.as_bytes()[offset..offset + 16].to_vec())
        })
        .collect();
    entries.sort();
    entries
}

#[test]
fn closed_geometry_and_blank_image_boundaries() {
    assert_eq!(CpmGeometry::Ibm3740.image_bytes(), DISK_IMAGE_BYTES);
    assert_eq!(CpmGeometry::Ibm3740.working_bytes(), WORKING_IMAGE_BYTES);
    assert_eq!(LARGE.id(), "triptych-cpm-8m-v1");
    assert_eq!(LARGE.image_bytes(), 8_388_608);
    assert_eq!(LARGE.working_bytes(), LARGE.image_bytes());
    assert_eq!(LARGE.directory_entries(), 512);
    assert_eq!(LARGE.system_bytes(), SYSTEM);
    let blank = CpmImage::blank(LARGE);
    assert_eq!(blank.free_space().unwrap().bytes, 8_355_840);
    assert_eq!(blank.free_space().unwrap().directory_entries, 512);
    assert!(blank.as_bytes()[..SYSTEM].iter().all(|byte| *byte == 0));
    assert!(blank.as_bytes()[SYSTEM..].iter().all(|byte| *byte == 0xe5));
    for length in [8_388_607, 8_388_609, 0, WORKING_IMAGE_BYTES + 128] {
        let message = CpmImage::from_bytes(vec![0; length])
            .unwrap_err()
            .to_string();
        assert!(message.contains("exactly"), "{message}");
        for accepted in ["256256", "256512", "8388608"] {
            assert!(message.contains(accepted), "{message}");
        }
    }
    assert_eq!(blank.clone().into_working_bytes(), blank.as_bytes());
}

#[test]
fn actual_word_blocks_255_256_and_last_block_roundtrip() {
    let base = CpmImage::blank(LARGE)
        .install("LAST.BIN", &[1; 128])
        .unwrap();
    for block in [255_u16, 256, 4087] {
        let mut bytes = base.as_bytes().to_vec();
        bytes[SYSTEM + 16..SYSTEM + 18].copy_from_slice(&block.to_le_bytes());
        let offset = SYSTEM + usize::from(block) * BLOCK;
        bytes[offset..offset + 128].fill(0x6a);
        let image = CpmImage::from_bytes(bytes).unwrap();
        assert_eq!(
            image.read("LAST.BIN").unwrap().unwrap().bytes,
            vec![0x6a; 128]
        );
        let changed = image.install("NEW.BIN", &[7]).unwrap();
        assert_eq!(
            changed.read("LAST.BIN").unwrap(),
            image.read("LAST.BIN").unwrap()
        );
    }
    let contents = vec![0x53; 249 * BLOCK];
    let installed = CpmImage::blank(LARGE)
        .install("CROSS.BIN", &contents)
        .unwrap();
    assert_eq!(
        installed.read("CROSS.BIN").unwrap().unwrap().bytes,
        contents
    );
    // Block255 is the last cell of extent30; block256 starts extent31.
    assert_eq!(
        &installed.as_bytes()[SYSTEM + 30 * 32 + 30..SYSTEM + 31 * 32],
        &[255, 0]
    );
    assert_eq!(
        &installed.as_bytes()[SYSTEM + 31 * 32 + 16..SYSTEM + 31 * 32 + 18],
        &[0, 1]
    );
}

#[test]
fn rejects_bad_word_references_including_unused_cells_without_mutation() {
    let base = CpmImage::blank(LARGE).install("ONE.BIN", &[1]).unwrap();
    for block in [0_u16, 7, 4088, 4095, 4096, 65535] {
        for cell in [0, 7] {
            if block == 0 && cell == 7 {
                continue;
            }
            let mut bytes = base.as_bytes().to_vec();
            let offset = SYSTEM + 16 + cell * 2;
            bytes[offset..offset + 2].copy_from_slice(&block.to_le_bytes());
            let image = CpmImage::from_bytes(bytes).unwrap();
            let before = image.clone();
            assert!(image.validate().is_err(), "block {block}, cell {cell}");
            assert!(image.read("ONE.BIN").is_err());
            assert!(image.install("NEW.BIN", &[2]).is_err());
            assert!(image
                .migrate_to(CpmGeometry::Ibm3740, &vec![0; SYSTEM_BYTES])
                .is_err());
            assert_eq!(image, before);
        }
    }
}

#[test]
fn fills_last_block_and_preserves_source_on_late_batch_failure() {
    let blank = CpmImage::blank(LARGE);
    let mut bytes = vec![0x39; blank.free_space().unwrap().bytes];
    *bytes.last_mut().unwrap() = 0x7e;
    let full = blank.install("FULL.BIN", &bytes).unwrap();
    assert_eq!(full.free_space().unwrap().allocation_blocks, 0);
    assert_eq!(full.as_bytes().last(), Some(&0x7e));
    assert_eq!(full.read("FULL.BIN").unwrap().unwrap().bytes, bytes);
    let before = blank.clone();
    assert!(blank
        .install_batch(&[
            FileImport {
                name: "FIRST.BIN",
                bytes: &[1]
            },
            FileImport {
                name: "FULL.BIN",
                bytes: &bytes
            },
        ])
        .is_err());
    assert_eq!(blank, before);
    assert!(full
        .migrate_to(CpmGeometry::Ibm3740, &vec![0; SYSTEM_BYTES])
        .is_err());
    assert_eq!(full.as_bytes().last(), Some(&0x7e));
}

#[test]
fn directory_entries_255_256_and_511_remain_distinct() {
    let names: Vec<_> = (0..512).map(|index| format!("F{index}.BIN")).collect();
    let imports: Vec<_> = names
        .iter()
        .map(|name| FileImport {
            name,
            bytes: &[0x6b],
        })
        .collect();
    let full = CpmImage::blank(LARGE).install_batch(&imports).unwrap();
    assert_eq!(full.files().unwrap().len(), 512);
    for index in [255, 256, 511] {
        let offset = SYSTEM + index * 32;
        assert_eq!(
            &full.as_bytes()[offset + 1..offset + 9],
            format!("F{index:<7}").as_bytes()
        );
        assert_eq!(full.read(&names[index]).unwrap().unwrap().bytes[0], 0x6b);
    }
    let before = full.clone();
    assert!(full.install("EXTRA.BIN", &[1]).is_err());
    assert_eq!(full, before);
}

#[test]
fn migration_preserves_all_users_attributes_empty_files_and_record_padding() {
    for geometry in [CpmGeometry::Triptych2M, LARGE] {
        check_migration_preserves_all_users(geometry);
    }
}

fn check_migration_preserves_all_users(target: CpmGeometry) {
    let mut source = CpmImage::blank(CpmGeometry::Ibm3740);
    for user in 0..16_u8 {
        source = source
            .install(
                &format!("U{user}.BIN"),
                &vec![user; 129 + usize::from(user)],
            )
            .unwrap();
    }
    source = source.install("BIG.BIN", &vec![0x55; 17_000]).unwrap();
    let mut bytes = source.into_working_bytes();
    bytes[..SYSTEM_BYTES].fill(0x76);
    bytes[DISK_IMAGE_BYTES..].fill(0x97);
    for user in 0..16_u8 {
        let entry = SYSTEM_BYTES + usize::from(user) * 32;
        bytes[entry] = user;
        // All users get the SAME name, and distinct attribute bits/data.
        bytes[entry + 1..entry + 9].copy_from_slice(b"SAME    ");
        bytes[entry + 1] |= 0x80;
        bytes[entry + 9] |= (user & 1) << 7;
        bytes[entry + 10] |= ((user >> 1) & 1) << 7;
        if user == 15 {
            bytes[entry + 15] = 0;
            bytes[entry + 16..entry + 32].fill(0);
        }
    }
    // Deliberately distinct attributes on the two extents of BIG.BIN.
    bytes[SYSTEM_BYTES + 16 * 32 + 10] |= 0x80;
    bytes[SYSTEM_BYTES + 17 * 32 + 9] |= 0x80;
    let source = CpmImage::from_bytes(bytes).unwrap();
    let before = source.clone();
    let migrated = source.migrate_to(target, &vec![0x42; SYSTEM]).unwrap();
    assert_eq!(source, before);
    assert_eq!(source.as_bytes()[DISK_IMAGE_BYTES], 0x97);
    assert_eq!(metadata(&migrated), metadata(&source));
    assert_eq!(&migrated.as_bytes()[..SYSTEM], vec![0x42; SYSTEM]);
    for user in 0..16 {
        assert_eq!(
            read_user(&migrated, user, "SAME.BIN"),
            read_user(&source, user, "SAME.BIN")
        );
    }
    assert!(read_user(&migrated, 15, "SAME.BIN").is_empty());
    assert_eq!(
        migrated.read("BIG.BIN").unwrap(),
        source.read("BIG.BIN").unwrap()
    );
    let returned = migrated
        .migrate_to(CpmGeometry::Ibm3740, &vec![0x43; SYSTEM_BYTES])
        .unwrap();
    assert_eq!(metadata(&returned), metadata(&source));
    for user in 0..16 {
        assert_eq!(
            read_user(&returned, user, "SAME.BIN"),
            read_user(&source, user, "SAME.BIN")
        );
    }
    assert!(source.migrate_to(target, &[0; 52 * 128]).is_err());
    assert_eq!(source, before);
}

#[test]
fn migration_rejects_sparse_or_malformed_sources_instead_of_skipping_users() {
    let base = CpmImage::blank(CpmGeometry::Ibm3740)
        .install("ONE.BIN", &[1])
        .unwrap();
    for (field, value) in [(12, 1), (16, 0), (0, 16), (1, b'?')] {
        let mut bytes = base.as_bytes().to_vec();
        bytes[SYSTEM_BYTES] = 15;
        bytes[SYSTEM_BYTES + field] = value;
        let source = CpmImage::from_bytes(bytes).unwrap();
        let before = source.clone();
        for target in [CpmGeometry::Triptych2M, LARGE] {
            assert!(source.migrate_to(target, &vec![0; SYSTEM]).is_err());
        }
        assert_eq!(source, before);
    }
}
