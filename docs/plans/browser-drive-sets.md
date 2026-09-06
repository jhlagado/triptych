# Browser drive sets

Date: 2026-09-07. Selected implementation design for the
[eight MiB disk milestone](eight-mib-disks.md). Storage and archive implementation
and browser integration pass local verification; hosted qualification remains open.

## Saved state and recovery

A saved machine contains the exact bootstrap bytes, an explicit resident-profile
label, drive A and an optional drive B. Each disk has its own name and complete
image. Restoring a set copies those bytes; it does not install the current OS or
infer a resident profile from image capacity. BIOS and application compatibility
remain governed by the [disk-profile contract](../specifications/cpm-disk-profiles-v1.md).

The browser publishes one complete manifest referencing immutable images by
SHA-256 and byte length. Identical images can share storage. Callers receive
independent byte arrays for A and B even when the saved contents are identical.
The persistence implementation alone manages image references and cleanup.

This addresses a specific backup cost: for N changes affecting only B, embedded
two-image snapshots require about `16 + 16N` MiB of image payload, whereas shared
images require about `16 + 8N` MiB. These are structural counts for two eight MiB
drives, not measurements of IndexedDB overhead or browser quota.

## Alternatives and review

The two candidates were complete embedded snapshots and immutable images behind
one drive-set manifest. Independent review compared them against six criteria:

| Criterion                         | Embedded snapshots                                                              | Shared images and manifest                                      |
| --------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Exact legacy recovery             | Viable with retained old stores                                                 | More explicit virtual legacy head and malformed-record handling |
| Whole-set concurrency and retries | Viable; original proposal incorrectly gated autosave on whole-machine readiness | Complete checkpoint vector and metadata-only receipts           |
| Storage and backups               | Repeats unchanged A for B-only changes                                          | Reuses unchanged images; requires safe cleanup                  |
| Caller interface                  | Small complete-snapshot interface                                               | Equally small if reference management stays private             |
| Browser acceptance                | Requires new browser tests                                                      | Requires the same tests plus reference and cleanup faults       |
| Implementation risk               | Fewer storage mechanisms                                                        | More internal complexity, with a concrete backup-space benefit  |

The selected base is shared images and one manifest. It uses the embedded
candidate's staged implementation sequence and explicit backed-up A/B
transition. It does not use the proposed all-idle autosave gate or an arbitrary
128 MiB storage cap. Browser quota and latency require measurements with the
actual workloads. A quota failure must preserve the preceding durable state;
the application must not delete backups to make room implicitly.

## Complete-set interface

The domain value is:

```text
{
  bootstrap: { profile, bytes },
  drives: {
    A: { name, bytes },
    B: null | { name, bytes }
  }
}
```

Bootstrap length is 256 bytes. The closed profile labels are `legacy-e400`,
`triptych-cpu-v0.1-8m-a` and `triptych-cpu-v0.1-8m-ab`. A/B requires eight MiB A
and, when present, eight MiB B. The one-drive profile requires eight MiB A and
absent B. `legacy-e400` retains the old decoder's positive, 512-aligned image
domain with absent B. That label records the historical bootstrap convention,
not verified identity of the saved operating system. Mountability and filesystem
validation are separate from raw recovery.

The codec copies caller data before its first asynchronous step. Preparation
returns a canonical manifest, its digest and image payloads. Restoration checks
every referenced length and hash before returning a complete snapshot. Manifest
identity includes names, drive positions, B presence and bootstrap/profile.

The store's caller interface is:

```text
load() -> empty | ready(token, snapshot) | recovery(error)
saveCheckpoint(expectedToken, snapshot) -> receipt
commitChange(expectedToken, operationId, snapshot) -> receipt
listBackups() -> backup metadata, including malformed-entry errors
readBackup(id) -> snapshot | undefined
readRawRecovery(storeName, key) -> exact stored value | undefined
close()
```

Receipts contain revision, operation identity and complete-set digest, with no
image payload. A repeated operation must match its original expected token and
candidate digest. Returning an old receipt cannot authorize activating its
candidate over a newer head; the coordinator must compare the current head
before activation. Tokens distinguish empty, legacy and version-three heads.
Legacy identity includes the original head's revision and operation metadata.

## Storage transactions and legacy data

Database version three adds `drive-set-blobs` and `drive-set-state`. Upgrading
creates stores only. It neither copies old images nor rewrites or deletes the
`working-disks` and `disk-revisions` stores. A blocked upgrade remains visible
until the old connection closes. New connections close on a later version change.

An existing version-two head takes precedence over version one, including when
malformed. A malformed head is a recovery state, never an empty database. A valid
legacy head can be exposed as a virtual complete set with an explicitly supplied
historical bootstrap. Its first successful publication uses a compare-and-swap
against that exact legacy state. Raw records and old backups remain accessible.
One malformed old backup must not hide the others.

Validation, copying and cryptographic hashing happen before a write transaction.
The transaction checks the current head against the expected token, inserts
missing images, records the displaced head for a manual change, writes its
metadata receipt and publishes the replacement head. Any abort rolls back all
of those operations. The single writer lease remains required in addition to
the revision check.

Cleanup can remove only new image blobs unreachable from the current head and
every retained backup. Receipts are metadata, not image roots. Publication and
cleanup use the same transaction. Malformed roots suspend cleanup; legacy
stores and backups are never removed automatically. Explicit backup deletion
is outside the first storage slice.

## Guest checkpoints and manual replacement

Autosave captures both drives' last successful checkpoints synchronously when
either drive's flush counter changes. It may publish `(new A, old B)` if B has
unflushed writes or its flush failed. It must never include those unflushed B
writes. This follows the existing per-drive flush contract: atomic publication
of a browser snapshot does not make guest writes to both drives a transaction.

Autosave therefore does not require `disk_management_ready()`. Requiring that
gate could prevent an acknowledged A checkpoint from becoming durable while B
remains dirty. The coordinator permits one save in flight and one newest pending
snapshot, so repeated flushes cannot form an unbounded queue of full image copies.

Manual replacement still requires whole-machine readiness. It uses a private,
unexecuted candidate machine and activates it only after durable publication.
Selected-drive file imports, tool updates, project operations and diagnostics
must bind to the drive and candidate generation captured at their start. A
delayed result must not affect a newly selected drive or replacement candidate.

Enabling A/B is an explicit operation with a whole-set backup. A legacy A image
is migrated by logical files into a freshly built A/B system. Converting a
previous eight MiB A preserves its filesystem and requires explicit system-area
replacement under the verified profile. B attachment or creation does not
install system bytes automatically. Removing B does not silently revert A's
resident profile.

## Portable recovery archive

A complete-set archive is independent of IndexedDB and WASM. Its layout is the
eight ASCII bytes `TRPTYDS3`, a four-byte little-endian manifest length, canonical
UTF-8 manifest JSON and each unique referenced image in ascending SHA-256 order.
The manifest identifies image lengths, so the decoder rejects truncation,
trailing bytes, contradictory references and hash mismatches. The manifest
parser is bounded to one MiB of metadata; this is not a disk-storage quota.

The manifest schema is `triptych-drive-set-v3`. It has `bootstrap` and `drives`
fields matching the domain shape, replacing each byte array with
`image: { sha256, byteLength }`. Field order is canonical: schema, bootstrap,
drives; profile before image; A before B; name before image; hash before length.
Unknown fields and noncanonical archive JSON are rejected. Hashes detect
corruption and mismatched components; they are not publisher signatures.

## Implementation sequence and evidence

1. Codec and store, including legacy adapters and transaction rollback. Prove
   exact round trips, stale and repeated operations, shared-image cleanup,
   malformed roots, blocked upgrades and quota failure at each publication stage.
2. Workspace coordinator and verified A/B assets. Prove captured checkpoint
   vectors in both partial-flush directions, bounded save queues, idle-only manual
   replacement and exact saved bootstrap reuse.
3. Drive-aware browser controls and recovery. Prove A/B file isolation, delayed
   operation rejection, backed-up transitions, complete-set download/restore and
   recovery when WASM or deployment asset loading fails.
4. Measure two-eight-MiB autosave latency, peak queued snapshot memory and repeated
   B-only backup growth. Run the complete repository check and independent review,
   then qualify the deployment and same-origin version-three recovery archive.

Each step depends on the preceding storage contract. Native optional-B support
and maximum tool-capacity proofs can proceed independently of this browser work.
