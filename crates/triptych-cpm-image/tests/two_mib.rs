use triptych_cpm_image::{CpmGeometry, CpmImage, FileImport};

const GEOMETRY: CpmGeometry = CpmGeometry::Triptych2M;
const SYSTEM: usize = 16_384;
const BLOCK: usize = 2048;

#[test]
fn exact_geometry_and_usable_capacity() {
    assert_eq!(GEOMETRY.id(), "triptych-cpm-2m-v1");
    assert_eq!(GEOMETRY.image_bytes(), 2_097_152);
    assert_eq!(GEOMETRY.working_bytes(), 2_097_152);
    assert_eq!(GEOMETRY.system_bytes(), SYSTEM);
    assert_eq!(GEOMETRY.directory_entries(), 1024);
    let blank = CpmImage::blank(GEOMETRY);
    let free = blank.free_space().unwrap();
    assert_eq!(free.allocation_blocks, 1000);
    assert_eq!(free.bytes, 2_048_000);
    assert_eq!(free.directory_entries, 1024);
    assert_eq!(
        CpmImage::from_bytes(blank.clone().into_working_bytes()).unwrap(),
        blank
    );
    assert!(blank.as_bytes()[..SYSTEM].iter().all(|b| *b == 0));
    assert!(blank.as_bytes()[SYSTEM..].iter().all(|b| *b == 0xe5));
    for size in [2_097_151, 2_097_153, 2_097_664] {
        assert!(CpmImage::from_bytes(vec![0; size]).is_err());
    }
}

#[test]
fn full_volume_reaches_last_record_without_wrapping_word_blocks() {
    let blank = CpmImage::blank(GEOMETRY);
    // Every record has a distinct two-byte address and every byte is checked.
    let contents: Vec<_> = (0..2_048_000)
        .map(|i| {
            if i % 128 == 0 {
                (i / 128) as u8
            } else {
                (i / 128 / 256) as u8
            }
        })
        .collect();
    let full = blank.install("FULL.BIN", &contents).unwrap();
    assert_eq!(full.free_space().unwrap().bytes, 0);
    assert_eq!(full.read("FULL.BIN").unwrap().unwrap().bytes, contents);
    assert_eq!(&full.as_bytes()[SYSTEM + 16 * BLOCK..], &contents);
    for block in [255_usize, 256, 1015] {
        let cell = block - 16;
        let offset = SYSTEM + (cell / 8) * 32 + 16 + (cell % 8) * 2;
        assert_eq!(
            &full.as_bytes()[offset..offset + 2],
            &(block as u16).to_le_bytes()
        );
    }
    let before = full.clone();
    assert!(full.install("EXTRA.BIN", &[1]).is_err());
    assert_eq!(full, before);
    assert!(blank
        .install_batch(&[
            FileImport {
                name: "FIRST.BIN",
                bytes: &[1]
            },
            FileImport {
                name: "FULL.BIN",
                bytes: &contents
            },
        ])
        .is_err());
    assert_eq!(blank.free_space().unwrap().allocation_blocks, 1000);
    let expanded = full
        .migrate_to(CpmGeometry::Triptych8M, &vec![0x31; SYSTEM])
        .unwrap();
    let returned = expanded.migrate_to(GEOMETRY, &vec![0x32; SYSTEM]).unwrap();
    assert_eq!(
        returned.read("FULL.BIN").unwrap(),
        full.read("FULL.BIN").unwrap()
    );
    let too_large = expanded.install("EXTRA.BIN", &[7]).unwrap();
    let before = too_large.clone();
    assert!(too_large.migrate_to(GEOMETRY, &vec![0; SYSTEM]).is_err());
    assert_eq!(too_large, before);
}

#[test]
fn one_thousand_small_files_exhaust_data_not_directory() {
    let names: Vec<_> = (0..1000).map(|i| format!("F{i}.BIN")).collect();
    let contents: Vec<_> = (0..1000_u16).map(u16::to_le_bytes).collect();
    let imports: Vec<_> = names
        .iter()
        .zip(&contents)
        .map(|(name, bytes)| FileImport { name, bytes })
        .collect();
    let full = CpmImage::blank(GEOMETRY).install_batch(&imports).unwrap();
    assert_eq!(full.files().unwrap().len(), 1000);
    assert_eq!(full.free_space().unwrap().directory_entries, 24);
    assert_eq!(full.free_space().unwrap().allocation_blocks, 0);
    for i in [255, 256, 511, 512, 999] {
        assert_eq!(
            &full.read(&names[i]).unwrap().unwrap().bytes[..2],
            &contents[i]
        );
    }
    assert!(full.install("EXTRA.BIN", &[1]).is_err());
}

#[test]
fn empty_directory_limit_and_final_slot_reuse_are_independent_of_data_space() {
    // Host import intentionally rejects empty input. Construct valid empty
    // on-disk entries here; the separate BDOS proof creates them via MAKE/CLOSE.
    let mut bytes = CpmImage::blank(GEOMETRY).into_bytes();
    for i in 0..1024 {
        let offset = SYSTEM + i * 32;
        bytes[offset..offset + 32].fill(0);
        bytes[offset + 1..offset + 9].copy_from_slice(format!("E{i:<7}").as_bytes());
        bytes[offset + 9..offset + 12].copy_from_slice(b"TXT");
    }
    let full = CpmImage::from_bytes(bytes).unwrap();
    assert_eq!(full.files().unwrap().len(), 1024);
    assert_eq!(full.free_space().unwrap().directory_entries, 0);
    assert_eq!(full.free_space().unwrap().allocation_blocks, 1000);
    for i in [255, 256, 511, 512, 1023] {
        assert!(full
            .read(&format!("E{i}.TXT"))
            .unwrap()
            .unwrap()
            .bytes
            .is_empty());
    }
    let before = full.clone();
    assert!(full.install("EXTRA.TXT", &[1]).is_err());
    assert_eq!(full, before);
    let mut bytes = full.into_bytes();
    bytes[SYSTEM + 1023 * 32] = 0xe5;
    let reused = CpmImage::from_bytes(bytes)
        .unwrap()
        .install("REUSE.TXT", &[0x6b])
        .unwrap();
    assert_eq!(
        &reused.as_bytes()[SYSTEM + 1023 * 32 + 1..SYSTEM + 1023 * 32 + 9],
        b"REUSE   "
    );
    assert_eq!(reused.free_space().unwrap().directory_entries, 0);
    assert_eq!(reused.free_space().unwrap().allocation_blocks, 999);
    assert_eq!(reused.read("REUSE.TXT").unwrap().unwrap().bytes[0], 0x6b);
    assert!(reused
        .migrate_to(CpmGeometry::Triptych8M, &vec![0; SYSTEM])
        .is_err());
}

#[test]
fn rejects_reserved_and_out_of_range_word_references_without_changing_source() {
    let base = CpmImage::blank(GEOMETRY).install("ONE.BIN", &[1]).unwrap();
    for block in [0_u16, 15, 1016, 65535] {
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
            assert!(image.install("NEW.BIN", &[2]).is_err());
            assert!(image.migrate_to(GEOMETRY, &vec![0; SYSTEM]).is_err());
            assert_eq!(image, before);
        }
    }
}
