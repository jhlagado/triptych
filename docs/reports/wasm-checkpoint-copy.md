# WASM drive checkpoint copying

Date: 2026-09-06. Status: implemented; focused correctness and native
provider measurements pass. This report does not qualify the complete 8 MiB
CP/M format, browser storage throughput, or physical hardware.

## Result and boundary

For 4,096 record-style write/flush operations against an 8 MiB backing image,
the native provider measurement fell from 790.589083 ms median to 0.139833 ms.
Checkpoint copying fell deterministically from 34,359,738,368 bytes (32 GiB)
to 2,097,152 bytes (2 MiB). The same operations on the 256,512-byte legacy
working image fell from 14.486458 ms to 0.199333 ms; checkpoint copying fell
from 1,050,673,152 bytes to 2,097,152 bytes. Clean flushes now copy zero
checkpoint bytes while retaining successful-flush counting.

The timing target is lower elapsed time for the same provider operations,
with unchanged checkpoint, per-drive ownership, flush-generation and readiness
semantics. Seven recorded samples follow one discarded warm-up for each size
and workload. The summary is median and median absolute deviation (MAD);
keep the change only when its improvement exceeds the observed spread and
the deterministic copy-count and correctness checks pass. Other work could
run on this host; these are not CPU-isolated timing claims. The measured
reduction is much larger than the sample spread.

| Workload (4,096 operations)              | Before median ± MAD (ms) | After median ± MAD (ms) |
| ---------------------------------------- | -----------------------: | ----------------------: |
| 256,512-byte image, record write + flush |     14.486458 ± 0.527125 |     0.199333 ± 0.024292 |
| 256,512-byte image, clean flush          |     13.354875 ± 0.024083 |     0.009916 ± 0.000042 |
| 8 MiB image, record write + flush        |   790.589083 ± 23.135917 |     0.139833 ± 0.001083 |
| 8 MiB image, clean flush                 |   773.038250 ± 20.356792 |     0.010208 ± 0.000375 |

Each write operation reads one 512-byte backing sector, modifies one 128-byte
quarter, writes the complete backing sector and flushes. The 4,096 operations
represent 512 KiB of guest record writes. Records wrap at image capacity,
so the legacy image is traversed more than once; the 8 MiB workload changes its
first 1,024 backing sectors. Every completed checkpoint is passed to
`black_box`; the final checkpoint must equal the live bytes and the flush
count must equal 4,096. The clean-flush contrast uses the same number of
flushes without writes.

The timer excludes image installation, checkpoint export, Z80 execution,
browser/IndexedDB persistence, disk-image parsing and native filesystem I/O.
The measured implementation is the real WASM host sector provider compiled
for native aarch64; it is not a browser-engine timing result.

## Implementation and memory

[The sector provider](../../crates/triptych-host-wasm/src/lib.rs) keeps its live
and checkpoint images. Each successful, validated sector write sets a membership
bit and appends its sector index only on the first write since the previous
flush. Flush copies each queued 512-byte sector once, clears membership and
reuses the list's allocated storage. Identical writes still count as writes.
Clean flushes still increment the wrapping flush counter. Checkpoint export
remains an independent copy; all public APIs and the existing readiness
conditions are unchanged.

Both tracking buffers are reserved when a drive is installed. For N backing
sectors, the requested payload is 4N bytes for the u32 index list plus
ceil(N/8) bytes for the membership bitmap. That is 67,584 bytes (66 KiB) for
an 8 MiB drive and 2,067 bytes for the 501-sector legacy working image,
excluding Vec headers and allocator bookkeeping. Repeated writes cannot
enqueue duplicates; the list never requires growth beyond N entries.
Writes and flushes therefore require no new allocations after installation.
The two existing full-image buffers remain: 16 MiB total for an 8 MiB drive.

Range validation finishes before either disk bytes or dirty tracking change.
The read and write ranges now use checked slice tails, avoiding an end-offset
addition before rejection on narrow address spaces. Flush reads only indices enqueued
by successful writes. Its body is synchronous and does not introduce provider
I/O, callbacks or new fallible operations between checkpoint copies.

## Reproduction

Baseline production revision:
`1589d7ebf9d2271a464446a1ff3039f68c6e02f3`.

Host: Apple M2, macOS 26.5.2 (25F84), aarch64-apple-darwin.
Compiler: rustc 1.98.0 (`88d9e12ae178fab0fb5cc050a94da85685d449ea`,
2026-08-18), LLVM 22.1.8. Both captures used the same native release build
profile and isolated target directory `/tmp/triptych-checkpoint-target.UlGF2a`.

The [frozen measurement module](../../crates/triptych-host-wasm/src/checkpoint_benchmark.rs)
has SHA-256
`fa2958cbc7f7149128321534450b23d074f7a7faf939e62463a33a4c99b483b3`.
It is a private, ignored test; normal test runs do not impose a timing gate.
The test-only copied-byte counter is absent from production builds.

For the before capture, the baseline library received only that module
declaration, a test-only u64 counter initialized to zero in each drive, and
this instrumentation immediately after its existing full-image copy:

```rust
drive.checkpoint.copy_from_slice(&drive.bytes);
#[cfg(test)]
{
    drive.checkpoint_copied_bytes += drive.bytes.len() as u64;
}
```

The after capture used the unchanged measurement module and incremented the
same counter by 512 for each checkpoint sector copied. The first optimized
capture changed the write guard and dirty-sector loop. A final capture repeated
the unchanged harness after applying the symmetric read-range guard, since
read_sector participates in the timed workload. The summary table uses that
final capture; both optimized captures are retained below.

The commands used this environment (choose another empty target directory
when repeating alongside an active build):

```sh
export CARGO_TARGET_DIR=/tmp/triptych-checkpoint-target.UlGF2a
export CARGO_HOME=/tmp/triptych-cargo
export RUSTUP_HOME=/tmp/nucleus-triptych-rust.5bPzOi
export PATH=/tmp/nucleus-triptych-rust.5bPzOi/toolchains/1.98.0-aarch64-apple-darwin/bin:/tmp/triptych-wasm-bindgen-0.2.127/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
export CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER=/tmp/triptych-rust-lld-1.98.0

cargo test --locked --release -p triptych-host-wasm checkpoint_copy_measurement -- --ignored --nocapture --test-threads=1
cargo test --locked -p triptych-host-wasm
cargo clippy --locked -p triptych-host-wasm --all-targets -- -D warnings
cargo check --locked --target wasm32-unknown-unknown -p triptych-host-wasm
```

Both native release builds reported that the installed rust-objcopy could not
find libLLVM.dylib while stripping debug information. They still completed
successfully and ran optimized test binaries; the same warning occurred for
before and after. It is a toolchain packaging limitation, not a failed
measurement or a browser result.

## Raw timing evidence

Each capture contains one discarded warm-up and seven recorded samples per
workload. Below are all harness measurement lines and their completion results.
The final capture also retains the command's build output. No samples were
removed. The initial optimized capture precedes the symmetric read guard;
the final capture supplies the report's after measurements.

### Baseline

```text
running 1 test
test checkpoint_benchmark::checkpoint_copy_measurement ... CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=0 elapsed_ns=20872542 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=1 elapsed_ns=17301000 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=2 elapsed_ns=15464125 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=3 elapsed_ns=14486458 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=4 elapsed_ns=13959333 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=5 elapsed_ns=14075584 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=6 elapsed_ns=14040417 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=0 elapsed_ns=13346667 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=1 elapsed_ns=13415292 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=2 elapsed_ns=13268417 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=3 elapsed_ns=13330792 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=4 elapsed_ns=13354875 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=5 elapsed_ns=13369458 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=6 elapsed_ns=13411833 copied_bytes=1050673152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=0 elapsed_ns=826048500 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=1 elapsed_ns=790589083 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=2 elapsed_ns=828087709 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=3 elapsed_ns=841287583 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=4 elapsed_ns=789555042 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=5 elapsed_ns=774612542 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=6 elapsed_ns=767453166 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=0 elapsed_ns=766659250 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=1 elapsed_ns=810820958 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=2 elapsed_ns=797690083 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=3 elapsed_ns=759628834 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=4 elapsed_ns=752681458 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=5 elapsed_ns=773038250 copied_bytes=34359738368
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=6 elapsed_ns=796217334 copied_bytes=34359738368
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 13 filtered out; finished in 12.94s
```

### Initial optimized capture

```text
running 1 test
test checkpoint_benchmark::checkpoint_copy_measurement ... CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=0 elapsed_ns=172958 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=1 elapsed_ns=260708 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=2 elapsed_ns=270875 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=3 elapsed_ns=211041 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=4 elapsed_ns=198958 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=5 elapsed_ns=135791 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=6 elapsed_ns=136667 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=0 elapsed_ns=9708 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=1 elapsed_ns=9750 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=2 elapsed_ns=9750 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=3 elapsed_ns=9750 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=4 elapsed_ns=12417 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=5 elapsed_ns=14084 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=6 elapsed_ns=14125 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=0 elapsed_ns=199792 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=1 elapsed_ns=202208 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=2 elapsed_ns=184125 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=3 elapsed_ns=186209 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=4 elapsed_ns=188542 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=5 elapsed_ns=187583 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=6 elapsed_ns=190875 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=0 elapsed_ns=9958 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=1 elapsed_ns=12792 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=2 elapsed_ns=12209 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=3 elapsed_ns=12125 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=4 elapsed_ns=12208 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=5 elapsed_ns=10375 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=6 elapsed_ns=12125 copied_bytes=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 15 filtered out; finished in 0.02s
```

### Final optimized capture

```text
loading zprofile
   Compiling triptych-host-wasm v0.1.0 (/Users/johnhardy/projects/triptych/crates/triptych-host-wasm)
warning: stripping debug info with `rust-objcopy` failed: signal: 6 (SIGABRT)
  |
  = note: dyld[46603]: Library not loaded: @rpath/libLLVM.dylib
            Referenced from: <AC0D75A8-23BF-301F-B7CE-3E5CC0C1BC06> /private/tmp/nucleus-triptych-rust.5bPzOi/toolchains/1.98.0-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/rust-objcopy
            Reason: tried: '/private/tmp/nucleus-triptych-rust.5bPzOi/toolchains/1.98.0-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/../lib/libLLVM.dylib' (no such file), '/private/tmp/nucleus-triptych-rust.5bPzOi/toolchains/1.98.0-aarch64-apple-darwin/lib/rustlib/aarch64-apple-darwin/bin/../lib/libLLVM.dylib' (no such file), '/tmp/triptych-checkpoint-target.UlGF2a/release/deps/libLLVM.dylib' (no such file), '/Users/johnhardy/lib/libLLVM.dylib' (no such file), '/usr/local/lib/libLLVM.dylib' (no such file), '/usr/lib/libLLVM.dylib' (no such file, not in dyld cache)


warning: `triptych-host-wasm` (lib test) generated 1 warning
    Finished `release` profile [optimized] target(s) in 2.08s
     Running unittests src/lib.rs (/tmp/triptych-checkpoint-target.UlGF2a/release/deps/triptych_host_wasm-291dbc0d4324a312)

running 1 test
test checkpoint_benchmark::checkpoint_copy_measurement ... CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=0 elapsed_ns=166125 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=1 elapsed_ns=230125 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=2 elapsed_ns=223625 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=3 elapsed_ns=205541 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=4 elapsed_ns=199333 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=5 elapsed_ns=186000 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=record-write-flush operations=4096 sample=6 elapsed_ns=138750 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=0 elapsed_ns=9750 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=1 elapsed_ns=9833 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=2 elapsed_ns=9875 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=3 elapsed_ns=9958 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=4 elapsed_ns=9916 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=5 elapsed_ns=9958 copied_bytes=0
CHECKPOINT_BENCH image_bytes=256512 workload=clean-flush operations=4096 sample=6 elapsed_ns=9917 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=0 elapsed_ns=139125 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=1 elapsed_ns=165333 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=2 elapsed_ns=140125 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=3 elapsed_ns=139833 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=4 elapsed_ns=138084 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=5 elapsed_ns=138625 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=record-write-flush operations=4096 sample=6 elapsed_ns=140916 copied_bytes=2097152
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=0 elapsed_ns=11584 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=1 elapsed_ns=9750 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=2 elapsed_ns=9750 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=3 elapsed_ns=9834 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=4 elapsed_ns=10583 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=5 elapsed_ns=10208 copied_bytes=0
CHECKPOINT_BENCH image_bytes=8388608 workload=clean-flush operations=4096 sample=6 elapsed_ns=10250 copied_bytes=0
ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 16 filtered out; finished in 0.02s
```

## Correctness and remaining gates

The new sparse-copy discriminator failed against the baseline: a 17-sector
image with four distinct written sectors copied 8,704 bytes instead of the
required 2,048. It passes after the change. It also proves repeated writes,
a membership-byte boundary, the final sector, identical writes after a flush,
and clean-flush counting.

Additional focused checks cover every sector written twice over two flush
generations, reinstallation into a smaller image, and the final 512-byte
sector of an 8 MiB drive while rejecting the first unavailable sector and
u32::MAX. Complete checkpoint comparisons prove untouched sectors survive.

Existing tests continue to cover independent drive checkpoints, failed and
write-protected writes, pending writes surviving an unrelated failure,
unflushed-write exclusion, successful per-drive flush counts, independent
exports, reset, and readiness requiring every drive to be flushed even after
identical writes.

The final focused suite passed 16 tests, with the measurement test deliberately
ignored. Failed reads preserve the caller's output buffer, including the LBA
0x7fffff whose end-offset addition can overflow a 32-bit usize. Native tests
prove rejection and output preservation; they do not reproduce a wasm32
arithmetic trap. The WASM target was checked by compilation, not executed in
this slice.

Focused native tests, lint, formatting and the WASM target check are the scope
of this slice. The coordinating task owns the combined full repository check.
Native filesystem flush latency, dense-batch throughput, browser export and
IndexedDB copy amplification, peak browser memory and mobile responsiveness
remain separate measurements. This change does not alter the guest's explicit
durability boundary or claim that all costs of 8 MiB disks are solved.
