# Two-MiB saved-machine codec qualification

Date: 2026-09-07. Scope: standalone v4 archive codec and compatibility dispatch.
The [format contract](../specifications/cpm-drive-set-v4.md) also specifies
storage and activation requirements; those layers remain unimplemented here.

## Implemented boundary

`drive-set-v4.js` validates and copies snapshots, prepares content-addressed
manifests, restores verified blobs, and encodes/decodes portable archives.
`saved-machine.js` dispatches between unchanged historical v3 operations and
v4 operations. Its equality operation validates and compares every machine
identity field without cloning disk payloads.

The old `drive-set.js`, `drive-set-store.js` and browser `app.js` are unchanged
by this slice. No user database has been upgraded and no new profile has been
enabled on the hosted website.

## Focused evidence

`npm run check:saved-machine-codecs` passed **79 tests**: 62 v4 codec tests,
eight compatibility tests and nine existing v3 tests. This command is now part
of `npm run check`.

The full `npm run check` completed successfully on this slice: 552 Vitest tests,
91 browser tests, the codec gate, native/WASM system and tool proofs, and Rust
formatting, lint, tests and WASM build. The later storage writer and isolated
native sparse-drive work are outside this result. The new codec is not yet
connected to the browser's active persistence path.

Coverage includes every configured count from 1 through 16, interior empty
slots, all sixteen distinct media, count/profile agreement, UUID identities,
exact name/byte limits and additional-field rejection. Archive cases include
canonical field ordering, duplicate JSON keys, alternative numeric/escape
spellings, malformed UTF-8, BOMs, truncation, oversized input and trailing data.
Payload tests cover missing/corrupt blobs, hash collisions, input mutation
after invocation and independent restored arrays for equal-content disks.

A fixed v3 archive fixture checks the exact legacy framing, metadata, payload
order and SHA-256. Legacy compatibility tests retain the previous snapshot
domain, including names outside the new v4 limits and positive 512-byte-aligned
legacy image lengths. These fixtures prove codec compatibility, not successful
guest execution for every historical byte sequence.

## Independent review

Read-only review found three weaknesses in tests, corrected before acceptance:

- Noncanonical metadata tests initially omitted valid payloads. They now retain
  those payloads so rejection must exercise metadata validation.
- Initial collision coverage used different lengths. An additional test uses
  distinct same-length disk contents with a deliberately colliding hash provider.
- One compatibility assertion expected a synchronous exception from asynchronous
  legacy restoration. It now observes the rejected promise.

The reviewer separately exercised noncanonical metadata with valid payloads,
equal-length collisions and SharedArrayBuffer rejection. No remaining codec or
dispatcher defect was found. This review did not qualify the future writer.

## Copy accounting

Instrumented codec-owned slice copies for sixteen occupied slots total
33,554,688 bytes during preparation and during blob-based restoration. Archive
decoding additionally copies its input archive once. At the format's maximum
archive bound, those decoder copies total at most 67,174,924 bytes.

These are instrumented copy totals, not process peak-memory measurements. They
exclude caller buffers, metadata, WebCrypto internals, IndexedDB structured
clones and WASM working/checkpoint arrays. Stored-blob deduplication does not
remove the requirement for independent writable arrays in each restored slot.

## Next verification boundary

The storage writer must prove marker-aware recovery, whole-machine publication,
predecessor backups and completion-level acknowledgement with real IndexedDB
failure injection. Historical migration must re-read and compare predecessor
blob bytes inside the write transaction after asynchronous preparation. Matching
head metadata alone cannot detect an intervening blob replacement.

Sparse native media ownership, runtime admission, complete tool arenas, browser
configuration, hosted qualification and ESP32 durability remain separate work.
