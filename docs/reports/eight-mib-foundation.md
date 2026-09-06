# Eight MiB disk foundation

Date: 2026-09-06. Status: first implementation slices, not a released milestone.
Triptych baseline: `1589d7ebf9d2271a464446a1ff3039f68c6e02f3`, branch
`eight-mib-disks`. Portable CP/M baseline:
`b07dad632e7ef3be6528289a5a35308983964b05`, branch `eight-mib-bdos`.

## Selected format

The [disk-profile contract](../specifications/cpm-disk-profiles-v1.md) defines
an exact 8,388,608-byte image, 128 records per track, one reserved track,
2 KiB allocation blocks and 512 directory entries. Initially free file storage
is 8,355,840 bytes. The one-drive BIOS allocation vector occupies FE00 through
FFFE, preserving the existing TPA and resident entry addresses.

The geometry comparison selected 128-record tracks for the shorter address
conversion and retained separate format, resident and saved-revision identities.
Implementation and independent review used the same boundary and failure tests.

## BDOS bounds correction

The new upstream suite initially had 20 failures and four passes. Invalid
allocation references could reach beyond the allocation vector or wrap during
record calculation. The correction adds a shared DSM bounds check before
vector indexing and block-to-record shifting, using the existing fatal disk
error and warm-boot path. It adds 22 resident bytes, no workspace, and leaves
94 bytes free in the fixed BDOS slot. The 64-byte resident stack is unchanged.

The final upstream suite has 29 large-profile tests, covering actual blocks
255, 256 and 4,087; physical record 65,535; random-record access; extent
transition; allocator carry; disk exhaustion; zero-fill; and malformed pointers.
Stack and allocation-vector canaries are checked. The upstream complete gate
passed 307 tests in 15 files, along with types, formatting, the ATOM guard and
release construction. Independent review reran 37 tests, including target
profiles, and found no actionable issue.

Corrected BDOS SHA-256:
`02956431e3af849d99eecbffbb89a0c7a29487f91301575d1dd511127ab4d43b`.
CCP bytes are unchanged. Red/green reports and the preceding source are retained
at `/tmp/portable-cpm-eight-mib.Mjhart/`. The initial boot pilots below used
version 0.1.1 and valid filesystem inputs.

The correction was merged upstream at
`2adfb035ec4de9a3a6dc629677fc8a0072cf0f74` and published as
[version 0.1.2](https://github.com/jhlagado/portable-cpm/releases/tag/v0.1.2).
Linux CI run 34031062227 passed on that merge. Its retained binaries and manifest
matched the local build byte-for-byte; downloaded release assets matched the CI
copies. Triptych now pins that release and its exact source snapshots. Post-pin
integration qualification is separate from the initial results below.

## BIOS and host image proofs

`system/cpm/bios-8m.asm` is the optional large-drive profile. The legacy
`bios.asm` remains byte-identical, with SHA-256
`8bb107b756a4794e0f9f7856f42bd236f2d9c8b9380a515eb2dc12a9b55f3414`.
The new ATOM output is 1,024 bytes at FA00, with SHA-256
`ef7558fcf3a9b99c814b50f196c0e053b3c4bb6e8c1114e0b91fd2e6e017764c`.
Its buffer and stack end below FE00. Nineteen direct BIOS tests passed, including
capacity 65,536 as a 32-bit count, wrong-size and unsupported-drive rejection,
final-record reads/writes, coordinate rejection before port writes and runtime
workspace guards. Independent review reran all nineteen tests successfully.

`tools/prove-large-disk.mjs` boots a blank large image, saves a file, renames it
and lists it using both WASM and the native macOS host. Serial transcripts and
complete final disk bytes match. Input image SHA-256:
`30233e14a04dd27287fdcea552d40afd72383e5b0d3272a4334dd988c0b63a36`.
Output SHA-256:
`8f3aa9fed6145c8f9b5b7df61040ed2a8e521df598f9805b23b5be6a46cb321b`.
The first harness attempt queued several commands together; CP/M's input polling
consumed typeahead during disk work. The corrected harness sends each command
after the preceding prompt. Product console behaviour was not changed.

The shared Rust image library implements both closed geometries and immutable
all-user migration with an explicit complete target system area. The native
utility adds `format` and `migrate`; both refuse existing destinations. WASM
uses the same library and rejects migration while imports are staged. The Files
API remains user-0-only; all-user preservation applies to migration.

The combined focused image/CLI/WASM suites passed 49 tests. One provider timing
test is deliberately ignored in ordinary test runs and was executed separately.
Independent review reran the same suites successfully. Tests cover high word
allocation entries, the final image byte, directory entries 255, 256 and 511,
full-capacity rejection, all users, attributes, empty files and source integrity.

`tools/prove-large-apps.mjs` migrates the pinned distribution through the WASM
binding, then runs ATOM, Edit and NUC. It changes the Nucleus example from O to
Y, compiles it, runs it to produce YK, and reopens the saved image in fresh native
and WASM machines. Fifteen checkpoints compare exact console bytes, ANSI state
and complete disk images. Final image SHA-256:
`d155669d9684c9f192b18665c19f4fad86c5f4b7f5193edd203cec5e9e533202`.
The proof retains raw transcripts and images in its reported temporary evidence
directory. `npm run check:cpm-large` runs both large-disk pilots, and is included
in the complete check command.

## Checkpoint copying

The [checkpoint report](wasm-checkpoint-copy.md) retains the frozen workload,
raw samples, copied-byte counts and limitations. For 4,096 record-style writes
with a flush after each, copying on an 8 MiB disk fell from 34,359,738,368 bytes
to 2,097,152 bytes. Native provider median time fell from 790.589 ms to 0.140 ms.
These figures exclude emulation, JavaScript export and browser storage.

Each successfully written backing sector is tracked once and copied at flush.
An identical write still requires a flush; clean flushes still advance the
counter. Pending writes to other drives and later unflushed data stay outside
the checkpoint. Tracking reserves 66 KiB per 8 MiB drive. No guest durability
boundary was removed.

## Release-pin and browser integration

After pinning Portable CP/M 0.1.2, ATOM reassembly of both retained source
snapshots matched the downloaded release executables. Both native/WASM large
proofs passed again using the same system-area builder as the browser. The
blank-image pilot ended with SHA-256
`9d75275bfb8774f985c10369032c259406c5023f87a1b633340bd8ade69e7f9a`;
the application workflow ended with
`fff4860c9ea9119d25fc20373a8420d781b73f2278d48ea0d4227219e35138b0`.

The browser stages a large-disk upgrade only after explicit confirmation and
verification of the matching system asset. It uses the existing atomic
head-and-backup transaction. Other staged changes must be applied or cancelled
first. Saved disks continue to reopen exactly. Explicit adaptation selects
the BIOS by geometry and preserves the imported image outside the resident slots.

Ten initial browser migration tests passed, followed by the full 58-test browser
suite. An additional real-terminal workflow then exercised ATOM compilation and
execution, Edit's O-to-Y source change, NUC compilation, YK output, and fresh-page
reopening. The final eleven migration tests passed three consecutive runs.
The preservation assertions compare complete image hashes, backup hashes and
user-0 file contents. All-user preservation is covered by the shared Rust image
tests; the Files interface itself still lists user 0.

The deployment verifier and recovery-archive fixtures passed 57 focused tests.
Independent review found no actionable issue in migration, system-asset
construction or the release pin, and separately probed metadata mismatches,
reserved-tail rejection and asynchronous snapshot isolation. These local browser
results do not establish hosted deployment or physical-phone responsiveness.

## Combined regression

The complete `npm run check` passed on 2026-09-06 after the first implementation
wave: 306 TypeScript tests, all 48 browser tests, the native terminal proof,
legacy and large-disk native/WASM application proofs, and Rust formatting,
Clippy, workspace tests and release WASM compilation. The provider timing test
remains explicitly excluded from ordinary runs as described above.

The preceding full run found one browser regression: invalid image sizes no
longer produced the precise expected-size diagnostic. A focused Rust test
reproduced the failure before the fix. The restored message lists all three
accepted byte lengths; both the focused test and the existing browser test
passed afterward. No disk-content assertions were weakened.

The complete post-pin and browser-integration run also passed on 2026-09-06:
336 TypeScript tests in 24 files, all 59 browser tests, native terminal and
native/WASM application proofs, Rust formatting, Clippy, workspace tests and
release WASM compilation. A further complete run passed after adding the
two-drive controller proof below. These local results do not establish hosted
deployment.

## Two-drive host boundary

`tools/prove-large-drive-isolation.mjs` assembles
`test/fixtures/large-drive-controller.asm` with ATOM, then executes its port
protocol on the production native and WASM hosts. Two independently filled
8,388,608-byte images receive 43 interleaved commands. Tests address record zero,
both sides of 2 MiB, the penultimate and final records, the first invalid record
65,536 and the maximum 32-bit address. The exact initial rejection is checked
before attempted payload transfer changes the protocol error.

The critical checkpoint test writes both drives, then flushes A while B's dirty
cache line is resident. B's live backing bytes change, but its checkpoint and
flush count remain unchanged until B is explicitly flushed. Management readiness
remains false in between. Complete-image comparisons distinguish cross-drive
aliasing and corruption outside the requested records.

A fresh native process and a fresh WASM instance each read 20 changed or adjacent
records, compare complete payloads and preserve both whole images. The WASM
probe halts with its stack restored to 8000. Native port replies match WASM at
every command; native file contents survive the process boundary. This test does
not independently measure native filesystem sync calls or power-loss durability.
Independent review and execution passed the same proof.

The assembled probe SHA-256 is
`291ce89d6c12b43dc4d0602ef36cd23d16048561e27525da4b9a96e3c7009e11`.
Final image SHA-256 values are:

- A: `41f131d17ed8b2b11e0a750f94d6bc0803334a2e9b56d2846b4997a3d949f9ad`.
- B: `00ad130ba861fd031748de808b63264f1d177aa6f67d432c27ffd32b9327a2ab`.

The proof is included in `check:cpm-large` and the full repository check. It
qualifies controller/host isolation, not multi-drive BDOS, BIOS or browser state.

## Remaining acceptance

The goal remains active. Required work includes multi-drive BDOS behavior,
the additional-drive BIOS and application memory profiles, coherent browser
drive-set publication and recovery, repeated regression checks after integration,
Linux CI and hosted recovery qualification.
Host results do not qualify physical ESP32 storage or phone responsiveness.
