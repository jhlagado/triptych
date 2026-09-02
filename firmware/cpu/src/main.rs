//! Stage 6 serial-only ESP32-S3 conformance image.
//!
//! This deliberately has no SD, video, sound, GPIO, or native-USB policy. Its
//! only job is to prove that the portable CPU core links into a pinned ESP-IDF
//! image and can report the checked fixture outcomes over the default UART.

use core::ptr::NonNull;
use std::thread;
use std::time::Duration;

use triptych_cpu_core::RAM_BYTES;
use triptych_cpu_selftest::{run_all, FixtureEvent, FIXTURE_COUNT};

const REPORT_FORMAT: u8 = 1;

struct InternalRam(NonNull<[u8; RAM_BYTES]>);

impl InternalRam {
    fn allocate() -> Option<Self> {
        let capabilities = esp_idf_sys::MALLOC_CAP_INTERNAL | esp_idf_sys::MALLOC_CAP_8BIT;
        // SAFETY: ESP-IDF returns either null or a suitably aligned allocation of
        // exactly RAM_BYTES bytes. This wrapper uniquely owns it until Drop.
        let pointer = unsafe { esp_idf_sys::heap_caps_calloc(1, RAM_BYTES, capabilities) };
        let pointer = NonNull::new(pointer.cast::<[u8; RAM_BYTES]>())?;
        Some(Self(pointer))
    }

    fn as_mut(&mut self) -> &mut [u8; RAM_BYTES] {
        // SAFETY: `self` uniquely owns the allocation and the mutable borrow
        // prevents another reference from being produced concurrently.
        unsafe { self.0.as_mut() }
    }
}

impl Drop for InternalRam {
    fn drop(&mut self) {
        // SAFETY: the pointer came from heap_caps_calloc and is freed once here.
        unsafe { esp_idf_sys::heap_caps_free(self.0.as_ptr().cast()) };
    }
}

fn main() {
    esp_idf_sys::link_patches();
    println!("TRIPTYCH-STAGE6 START format={REPORT_FORMAT} fixtures={FIXTURE_COUNT}");

    let Some(mut ram) = InternalRam::allocate() else {
        println!("TRIPTYCH-STAGE6 FAIL kind=internal-ram-allocation bytes={RAM_BYTES}");
        halt();
    };

    let summary = run_all(ram.as_mut(), |event| match event {
        FixtureEvent::Passed(pass) => {
            print!("TRIPTYCH-FIXTURE PASS id={} digest=", pass.fixture);
            print_hex(&pass.result_sha256);
            println!();
        }
        FixtureEvent::Failed(failure) => println!(
            "TRIPTYCH-FIXTURE FAIL id={} kind={} detail={} index={}",
            failure.fixture,
            failure.kind.as_str(),
            failure.detail,
            failure.index
        ),
    });

    println!(
        "TRIPTYCH-STAGE6 SUMMARY passed={} failed={}",
        summary.passed, summary.failed
    );
    halt();
}

fn print_hex(bytes: &[u8]) {
    for byte in bytes {
        print!("{byte:02x}");
    }
}

fn halt() -> ! {
    loop {
        thread::sleep(Duration::from_secs(3_600));
    }
}
