//! Frozen provider-level timing harness. Run explicitly in a native release build.
//! It excludes image installation, checkpoint exports, IndexedDB and emulation.

use super::*;
use std::hint::black_box;
use std::time::Instant;

const OPERATIONS: usize = 4096;
const SAMPLES: usize = 7;

fn sample(image_bytes: usize, writes: bool) -> (u128, u64) {
    let mut store = WasmSectorStore::default();
    store.install(0, &vec![0; image_bytes], true).unwrap();
    let mut sector = [0; SECTOR_BYTES];
    let started = Instant::now();
    for operation in 0..OPERATIONS {
        if writes {
            let record = operation % (image_bytes / 128);
            let lba = (record / 4) as u32;
            store.read_sector(0, lba, &mut sector).unwrap();
            let offset = record % 4 * 128;
            sector[offset..offset + 128].fill((operation as u8).wrapping_add(1));
            store.write_sector(0, lba, black_box(&sector)).unwrap();
        }
        store.flush(0).unwrap();
        // Make each completed checkpoint observable, not just the final image.
        black_box(store.drive(0).unwrap().checkpoint.as_slice());
    }
    let elapsed = started.elapsed().as_nanos();
    let drive = store.drive(0).unwrap();
    assert_eq!(drive.checkpoint, drive.bytes);
    assert_eq!(drive.flush_count, OPERATIONS as u32);
    assert!(!drive.writes_since_flush);
    (elapsed, drive.checkpoint_copied_bytes)
}

#[test]
#[ignore = "explicit native release measurement; not a timing assertion"]
fn checkpoint_copy_measurement() {
    for image_bytes in [256_512, 8 * 1024 * 1024] {
        for writes in [true, false] {
            let workload = if writes {
                "record-write-flush"
            } else {
                "clean-flush"
            };
            sample(image_bytes, writes);
            for index in 0..SAMPLES {
                let (elapsed_ns, copied_bytes) = sample(image_bytes, writes);
                println!(
                    "CHECKPOINT_BENCH image_bytes={image_bytes} workload={workload} operations={OPERATIONS} sample={index} elapsed_ns={elapsed_ns} copied_bytes={copied_bytes}"
                );
            }
        }
    }
}
