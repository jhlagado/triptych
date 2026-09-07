# Native CP/M CLI ownership

The `triptych-cpm` executable now has its own host-only package,
`triptych-cpm-cli`, with Rust 1.89 as its minimum version. Its normal dependency
is the existing `triptych-cpm-image` library, which retains Rust 1.85 and has no
new filesystem or locking requirement. `cargo tree -p triptych-cpm-cli -e normal`
contains only those two packages. The native host is a development-only
dependency for process contention tests.

The package move was qualified independently: the five original CLI tests
passed before and after the move, and both the command implementation and test
file moved byte-for-byte. The executable name, commands, flags and successful
output remain unchanged. Current Cargo examples and the native image proof
build command now select the CLI package; historical reports retain their
original commands.

## Ownership and publication

The CLI acquires exclusive `File::try_lock` locks on opened regular-file inputs
and existing replacement targets. Read-only handles also require the lock.
Contention and unsupported locking fail without an unlocked fallback. Locks
remain held through parsing, transformation and publication; dropping a guard
explicitly unlocks its descriptor.

An import borrows its already locked image as the replacement target. Export
with `--force` locks an existing destination separately. Consequently, a source
alias cannot also become a replacement target. Creating a destination uses a
same-directory, locked temporary file and atomic no-clobber hard-link
publication. This remains true for `--force` when its destination was initially
absent. Existing or newly appearing dangling symlinks are preserved.

Replacing a file checks source and destination pathname identities, then
renames the locked candidate while retaining the old inode's lock. The new
inode stays locked through cleanup. A failure before publication leaves the
destination unchanged. After successful publication, a cleanup error explicitly
reports the published output; cleanup never removes that output or an unrelated
entry that replaced the temporary pathname.

## Focused evidence

The two initial regressions failed on the moved, unchanged CLI: an owned input
was accepted and `export --force` replaced an actively locked destination. They
passed after the ownership helper was integrated.

The macOS focused suite covers:

- Nine helper tests: locks across rename, old-inode alias retention,
  no-clobber races, dangling symlinks, changed source/destination identities,
  post-publication cleanup failure, partial-acquisition release, read-only
  permissions and FIFO preflight. Interleavings occur at the actual helper
  boundary without timing sleeps or production fault-injection switches.
- Eight CLI tests: the five original scenarios, the two locking regressions,
  and failed imports or forced exports through same-file/hard-link/symlink
  aliases. Preservation and subsequent lock acquisition are checked.
- Two native-owner scenarios plus one process-helper test. A pipe handshake
  holds distinct A/P images in the actual native `FileSectorStore` while a
  separate CLI process attempts reads, imports and forced replacement. Another
  scenario covers hard-link and symlink aliases of read-only media. Access
  succeeds after the owner releases its locks.

Reproduction commands, with the repository's pinned Rust toolchain:

```sh
cargo test -p triptych-cpm-cli
cargo clippy -p triptych-cpm-cli --all-targets -- -D warnings
cargo tree -p triptych-cpm-cli -e normal
```

These tests qualify host file ownership, not guest execution or bootable A/P
media. This change does not modify the native host, core, WASM runtime,
assembly, distribution descriptors or release pins. Linux remains a separate
execution gate; the tests here ran on macOS. The complete repository check
remains the integration coordinator's responsibility.

An independent review of worker commits `d3c35bc` and `99166e9` found no
actionable issues. The reviewer reran all 20 focused tests with an isolated
build directory on macOS/Rust 1.98, checked the production dependency tree and
compared the moved files with their originals. The lead separately read the
full helper, callers, tests and actual native acquisition path, with the same
verdict. Triptych integrated the commits as `b8cc34e` and `fce29ee`; minimum
Rust-version execution and Linux qualification remain unproved by this review.

The first combined check then exposed one missed caller outside the reviewed
worker slice: `files-binding.spec.mjs` still selected the old Cargo package.
Its native/WASM comparison failed before reaching the filesystem assertions;
the other 154 browser tests passed. Updating that caller to `triptych-cpm-cli`
made both focused binding tests pass in 6.8 seconds. The assertions remain
unchanged. This correction requires another complete integration check.

## Filesystem limits

Locks are advisory: other programs must cooperate. The inode comparisons
detect pathname substitutions before publication but are not an atomic
compare-and-rename primitive. They do not protect against hostile changes
between the final comparison and rename. Non-regular preflight avoids ordinary
FIFO/device blocking but does not establish a race-proof open operation.
Network filesystem locking support and physical power-loss durability were not
measured. Candidate contents are synced before publication; directory fsync is
not added. A process crash may leave a temporary file for manual inspection.
