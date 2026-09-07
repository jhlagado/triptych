# Two-MiB browser system APIs

The isolated `two-mib-system.js` module implements fresh asset verification and
saved-machine admission. It does not install residents, modify storage, create
a CPU or activate a machine. Application and deployment wiring remain separate
gates under the [selected design](two-mib-system-admission-design.md).

## API and failure behavior

`fetchTwoMibSystem({ deployment, configuredCount, baseUrl, fetch, crypto })`
returns `{ system, bootstrap, descriptor }`. All returned byte arrays and
descriptor metadata are private copies. It validates the selected count,
profile, layout, release identities and canonical asset paths before network
access. It then reads the system and bootstrap sequentially, verifies full and
component hashes, and checks DPB bytes, DPH/ALV pointers, table padding, the
SELDSK count operand and bootstrap load addresses.

`admitTwoMibSavedMachine({ snapshot, deployment, crypto })` returns either
`{ status: "admitted", snapshot, descriptor }` or
`{ status: "unavailable", snapshot, code, reason }`. Admission copies the entire
structurally validated snapshot before its first asynchronous operation and
hashes only the saved bootstrap. It never fetches installation assets or compares
saved resident bytes with a release. Guest changes to CCP, BDOS, BIOS, the
reserved tail and filesystem bytes remain unchanged.

The unavailable codes are `PROFILE_UNAVAILABLE` and
`SAVED_BOOTSTRAP_MISMATCH`. Malformed saved structures throw
`SAVED_MACHINE_INVALID`; malformed or contradictory descriptor metadata throws
`PROFILE_METADATA_INVALID`. Fetch and stream failures throw
`PROFILE_ASSET_UNAVAILABLE`; byte, hash or machine-layout failures throw
`PROFILE_ASSET_INVALID`. Missing SHA-256 support throws
`PROFILE_HASH_UNAVAILABLE`. Exceptions preserve the caller's original objects;
the caller must retain recovery access and must not initialize over saved
authority after an error or unavailable result.

New metadata occupies the optional `twoMibProfiles` collection. Its absence in
a historical deployment means that no two-MiB profile is available. A present
collection is validated completely, including malformed unselected profiles
and duplicate profile/asset rows. Existing `diskProfiles` are not changed.
Qualified subset registries may omit the complete distribution object. When
outer `distribution.triptych.revision` or `dirty` fields are supplied, they
must match every supplied descriptor's machine identity. A full release
verifier must separately require complete provenance and all sixteen profiles.

## Bounds and ownership

The metadata limit is sixteen profile descriptors and 4,096 asset rows; asset
basenames contain at most 255 characters. Descriptor objects have exact field
sets and fixed-size hashes. Accessor properties, extra symbols and sparse
metadata arrays are rejected. Metadata capture does not invoke `toJSON` or
caller iterators.

A fresh fetch retains one 16,384-byte system and one 256-byte bootstrap buffer.
Stream chunks are copied directly into their fixed destination; the first
excess chunk rejects the response and triggers best-effort cancellation. The
implementation does not accumulate arbitrary response bodies before testing
their sizes. Browser transport buffers and WebCrypto allocations are outside
this application-buffer count.

Saved admission creates one owned copy of each present disk and the bootstrap,
up to 33,554,688 bytes for sixteen disks. Equal or aliased input contents produce
independent output arrays. SharedArrayBuffer-backed input is rejected by the v4
copy boundary; Node Buffer views are copied as bytes rather than retaining a
view of the caller's allocation. This is a buffer inventory, not a measured
browser peak. Runtime preparation, persistence and archives add other copies.

## Focused verification

The synthetic contract suite runs without a builder or browser server:

```sh
node --test --test-concurrency=2 test/wasm/two-mib-system.node.mjs
```

It covers all sixteen named profiles, paired-count substitutions with updated
hashes, source/layout/path mismatches, mutations during asynchronous work,
Buffer and shared-memory boundaries, full sixteen-media capture, stream
overflow/truncation/failure and preserved modified saved bytes. Synthetic
machine bytes qualify validation behavior, not guest execution.

The separate artifact gate consumes a captured, verified all-profile builder
run. Each `nNN` directory contains `descriptor.json`, `system.bin` and
`bootstrap.bin`:

```sh
TRIPTYCH_TWO_MIB_FIXTURES=/path/to/captured-build \
node --test --test-concurrency=2 test/wasm/two-mib-system-artifacts.node.mjs
```

That gate verifies every actual tuple through fetch and admission, then runs
the n01/n16 APIs in real Chromium using an intercepted secure origin. It starts
no listening server and performs no assembly. Missing fixtures fail explicitly.
Playwright and its Chromium installation are required for that gate.

On macOS, the synthetic suite passed **77 tests** and the captured-artifact gate
passed **17 tests**, including the real Chromium case. The captured builder
output was stored at `/tmp/triptych-two-mib-browser-fixtures.371Bnr`. Its machine
metadata identifies revision `740eecb7d02a3da04b004ecb7e9e06378bd9ec31`,
`dirty: true`, and generator SHA-256
`8d33db1150132fd568c28a170e473341ab2c582c4410479f6d5502103e6e8372`.
Those development artifacts use Portable CP/M 0.1.4 at
`d28fc52774c967d1422b3b814d51c069247504c1` and ATOM at
`802b5c2d320bec777f427755ff2d7338e3b80a05`. They are not a clean release build.
The browser test compares modified saved disk bytes and their SHA-256 against
the Node result, and checks that admission makes no asset requests.

The v4 representation cannot distinguish a consistently relabelled paired-count
snapshot from permitted guest BIOS changes. Saved admission therefore does not
prove historical installation identity, correct BIOS drive count or bootability.
Fresh installation still checks the configured count against generated tables
and the named component tuple. Host tests establish no ESP32 measurements.
