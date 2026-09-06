# Saved drive sets, version 4

Status: selected contract, 2026-09-07. Codec implementation and verification are
in progress. Transactional storage and browser activation are not yet qualified.

This format records a complete configured machine in the
[two-MiB disk family](cpm-two-mib-v1.md). Configured slots and inserted media are
separate: four configured slots with only A inserted still use the four-slot
resident layout. The archive preserves disk bytes, bootstrap bytes and media
identities. It contains no running CPU state.

## Snapshot and manifest

A snapshot has exactly these fields, in the order used for canonical output:

```text
schema: "triptych-drive-set-v4"
configuredCount: integer N, 1 through 16
bootstrap: { profile, bytes }
slots: array of N entries
```

The profile is exactly `triptych-cpu-v0.1-2m-nNN`, with the configured count
written as two decimal digits. Bootstrap bytes have length 256. Each slot is
either `null` or `{ instanceId, name, bytes }`. Slot zero, A, requires media;
other slots may be empty. Every inserted image has exactly 2,097,152 bytes.
Array holes and additional array properties are invalid.

The manifest replaces each `bytes` field with an `image` reference:

```text
schema
configuredCount
bootstrap: { profile, image: { sha256, byteLength } }
slots: [null | { instanceId, name, image: { sha256, byteLength } }, ...]
```

Object fields must match these sets exactly. Canonical serialization uses the
displayed field order, compact ECMAScript `JSON.stringify` output and UTF-8.
The manifest digest is SHA-256 of those canonical bytes. Hash strings contain
exactly 64 lowercase hexadecimal characters. Reference lengths must match
their bootstrap or disk role; one hash cannot have conflicting lengths.

An instance ID is a canonical lowercase UUIDv4, unique among inserted media.
Disk writes, checkpoints and slot reconfiguration preserve that ID. Creating
or independently importing a disk assigns a new ID. Restoring a whole-machine
archive preserves its IDs. Equal names and equal contents are permitted for
distinct instances.

Names are nonempty, well-formed Unicode strings of at most 255 UTF-8 bytes.
NUL and unpaired UTF-16 surrogates are invalid. Encoding and decoding must not
normalize, truncate or rename them. These constraints apply only to v4, not
to historical formats.

## Archive framing

| Offset |   Length | Contents                                                 |
| -----: | -------: | -------------------------------------------------------- |
|      0 |        8 | ASCII `TRPTYDS4`                                         |
|      8 |        4 | Unsigned little-endian manifest byte length M            |
|     12 |        M | Canonical UTF-8 manifest JSON                            |
| 12 + M | Variable | Unique referenced payloads in ascending ASCII hash order |

Each referenced hash has one payload. There is no compression, padding,
filename table or trailing data. Sorting must not depend on locale.

The manifest length is 1–65,536 bytes. There are at most 17 unique references:
one bootstrap and sixteen disks. The maximum payload is 33,554,688 bytes and
the maximum complete archive is **33,620,236 bytes**. These are v4 limits;
historical readers retain their existing accepted domains.

Decoding checks total and metadata bounds before an archive-sized allocation.
UTF-8 decoding is fatal on malformed input. A byte-order mark is retained so
JSON parsing or canonical comparison rejects it. After strict structural
validation, reserialization must equal the original metadata text exactly.
This rejects duplicate keys, alternative field order, added whitespace,
alternative escapes and numeric spellings such as `4.0`.

The calculated payload length must equal the remaining input exactly. Accepted
input is copied into private storage before the first asynchronous operation.
Every referenced payload is hash-verified before returning a snapshot. Hashing
is sequential. Restored slots have independent mutable arrays, including when
their stored contents were deduplicated. Snapshot preparation and blob-based
restoration likewise capture all input bytes before asynchronous hashing.
SharedArrayBuffer-backed input is rejected because another execution context
could mutate it during capture.

## Historical compatibility and execution admission

The existing v3 codec remains unchanged. Snapshot dispatch uses an own `schema`
property: its absence invokes the strict historical snapshot validator; its
presence requires the exact v4 schema. Manifest dispatch requires a recognized
schema. Archive dispatch requires exact `TRPTYDS3` or `TRPTYDS4` magic. An unknown
version or damaged archive never falls back to raw-disk import. Raw images are
imported through a separate explicit operation.

Structural validity does not establish permission to execute a profile. Runtime
admission requires an available, verified descriptor for the exact profile and
bootstrap. A structurally valid archive with an unavailable descriptor remains
recoverable and exportable, but cannot activate a substitute profile. Unknown
profiles fail normal interpretation; their original recovery data is retained.

Creation and explicit resident reconfiguration install verified component
tuples. Ordinary reopening and checkpoints preserve saved resident bytes,
including guest modifications. They do not silently reinstall current OS or
tool releases, nor establish that the saved guest system is still bootable.

## Durable authority and backups

Database version 4 adds isolated `drive-set-state-v4` and `drive-set-blobs-v4`
stores. Historical stores and their records remain unchanged. A new head or
backup envelope may contain a validated v3 or v4 manifest; storage version and
disk geometry are independent.

A permanent activation marker is committed atomically with the first new head.
An empty, never-activated new store may use historical authority, in the order
v3, v2, then v1. At each historical level, record presence takes precedence over
validity: damaged authority requires recovery rather than fallback.

After activation, a missing or invalid new head requires recovery. A head
without its marker, or unexplained new-state records, also requires recovery.
Neither condition may resurrect an older machine or initialize a fresh seed.

The first publication copies the predecessor's referenced blobs into the new
store and retains its validated manifest as a complete preceding backup. For
v1/v2, the existing historical-bootstrap adapter supplies that complete
representation; original records remain untouched. This duplication can exceed
available quota. Failure leaves previous authority intact; deleting historical
data to make the publication fit is prohibited.

Publication uses a compare-and-swap authority token. One readwrite transaction
checks the predecessor again, validates or adds immutable blobs, records the
required predecessor backup and receipt, and replaces the head. The first such
transaction also adds the activation marker. Acknowledgement follows transaction
completion, not request success. The result includes both `{ token, receipt }`;
callers do not infer authority version from a receipt. Retries bind operation
identity, predecessor token and candidate digest. Before runtime activation,
the workspace verifies that the published head is still authoritative.

Garbage collection affects only the new blob store. Its roots include every
new-store head and backup, across both manifest versions. Receipts are not blob
roots. Unknown or malformed roots, or missing referenced blobs, suspend garbage
collection. Historical stores are never cleanup targets. Backup listing reads
metadata rather than eagerly loading every image.

Exact storage-envelope and token encodings require separate implementation
tests before a writer is enabled; they are not part of the portable archive.

## Reconfiguration and resource limits

Count changes, insertion, ejection and archive restore checkpoint and pause the
machine, prepare a private candidate and unexecuted CPU, publish the complete
candidate with a preceding backup, verify durable authority, then cold reboot.
Live hot swap is outside this contract. A count reduction retains removed media
in the preceding complete backup. Ordinary saves use acknowledged checkpoint
bytes per drive; a flush on A must not publish unflushed writes on P.

The autosave queue retains at most one in-flight and one newest pending snapshot.
Management drains that queue before retaining its baseline and candidate.
Neither bound establishes total browser memory use: old and prepared CPUs,
WASM working/checkpoint arrays, caller buffers, IndexedDB clones and hashing
allocations are additional costs. Sixteen media require 32 MiB per complete
snapshot even when all immutable stored blobs deduplicate to one disk.

Release qualification must measure a full sixteen-drive save, archive round
trip, unchanged-blob reuse and management peak separately. Browser proofs do
not establish ESP32 memory capacity or physical power-loss durability.
