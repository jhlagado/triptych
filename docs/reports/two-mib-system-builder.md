# Two-MiB fresh system builder

Date: 2026-09-07. Status: focused construction and integrity checks pass;
browser activation, complete tool qualification and release publication remain
separate work.

The builder in [two-mib-system.mjs](../../tools/lib/two-mib-system.mjs) constructs
the sixteen named two-MiB resident profiles from retained Portable CP/M 0.1.4
and Triptych's captured BIOS/bootstrap source. It creates private artifacts;
it does not read saved media, install files, modify a deployment or start a CPU.
The [disk specification](../specifications/cpm-two-mib-v1.md) and
[v4 preservation contract](../specifications/cpm-drive-set-v4.md) remain the
authorities for subsequent management operations.

## Interface and ownership

```js
await buildTwoMibSystem(repositoryRoot, configuredCount, { allowDirty: false });
// -> { system, bootstrap, descriptor, evidence }

validateTwoMibSystem(result, configuredCount);
// -> the same result after synchronous fresh-artifact verification
```

Count is an integer from 1 through 16. The default build requires a clean
checkout; a development caller must explicitly allow dirty source. The
descriptor records both the revision and dirty status. A root whose generator
bytes differ from the implementation captured at module initialization is
rejected. The builder uses the selected root's captured machine templates and
exact named resident lock; it has no source-checkout discovery or network path.

The returned system is exactly 16,384 bytes: CCP at offset 0 for 2,048 bytes,
BDOS at 2,048 for 3,584 bytes, BIOS at 5,632 for 1,024 bytes, then zeroes.
Bootstrap is exactly 256 bytes. These output arrays are detached from the
assembled evidence arrays. A caller owns its returned build; the synchronous
validator does not transfer ownership or make a snapshot.

Evidence retains exact lock, package manifest, npm lock, native ATOM seed and
generator bytes. `evidence.residents.ccp` and `.bdos` contain assembled
`{ base, bytes, labels }` and captured raw/prepared source, release bytes,
manifest bytes and provenance bytes. `evidence.machine.bios` and `.bootstrap`
contain the corresponding assembled triples; machine evidence also retains
raw template bytes, generated source, root, paths and source provenance.
Later lifetime tests can derive stack and writable-storage boundaries from
these complete symbol maps without assembling a different copy of the source.

`readVerifiedRelease` has an opt-in `{ captureEvidence: true }` third argument.
Its default result remains exactly `{ bytes, manifest }`. The captured arrays
are detached from parsed metadata and from subsequent reads.

## Descriptor contract

The closed `triptych-two-mib-system-v1` descriptor has these top-level fields:

| Field                                | Meaning                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `schema`, `id`                       | Descriptor version and `triptych-cpm-2m-v1` format                                                       |
| `residentProfile`, `configuredCount` | Exact `triptych-cpu-v0.1-2m-nNN` identity and N                                                          |
| `imageBytes`, `systemBytes`          | 2,097,152-byte disk and 16,384-byte system area                                                          |
| `layout`                             | CCP, BDOS, BIOS, allocation base/bytes, common limit, DPH base/end                                       |
| `system`                             | Canonical asset name, byte length and SHA-256                                                            |
| `bootstrap`                          | Canonical asset identity plus raw/prepared source hashes                                                 |
| `residents`                          | Named lock/manifest paths and hashes, release repository/version/revision, CCP and BDOS identities       |
| `bios`                               | Raw/prepared/output hashes, source path, common end, directory buffer, DPB and checksum-vector addresses |
| `atom`                               | Locked repository/revision/package/seed plus package integrity                                           |
| `machine`                            | Revision, dirty status, generator path and captured digest                                               |

Asset names are `system-triptych-cpm-2m-nNN-v1.bin` and
`bootstrap-triptych-cpm-2m-nNN-v1.bin`. Each resident entry contains source path,
raw/prepared/output SHA-256, disk offset, origin and byte length. All source
paths in the descriptor are repository-relative; absolute captured paths stay
in development evidence. `describe` in the implementation defines the exact
nested field sets. No existing deployment descriptor or asset name changed.

The builder checks the ATOM Git spec in package.json and package-lock.json,
the npm lock's resolved identity and package integrity, the actual loaded
native seed's length/digest, and the retained OS manifest's assembler identity.
This follows the existing distribution builder's trusted local installation
model; it does not authenticate an arbitrarily modified host package.

## Focused evidence

The new Node suite checks all sixteen counts, every adjacent odd/even pair,
closed descriptor fields, wrong named locks, changed templates, a mismatched
generator, altered release/source evidence and detached output storage.
Recomputed outer hashes do not admit a neighbouring BIOS, a changed configured
count operand, an incorrect ALV pointer, nonzero unused DPH entries or a
nonzero system tail. Bootstrap checks independently inspect scratch addresses,
resident origin, record count and overlay-exit BIOS target.

All profiles reproduce the retained CCP/BDOS byte identities. Common BIOS
storage measures 723 of 768 bytes. Each count has exactly N 16-byte DPHs and
the specified ALV pointers. Adjacent counts share CCP, BDOS and bootstrap bytes
and have different BIOS bytes, system digests and named locks. Full source and
output evidence remains available in each build result.

Commands used for this bounded change:

```sh
node --test --test-concurrency=1 tools/lib/two-mib-system.test.mjs
npx vitest run test/distribution/two-mib-release-inputs.test.mjs test/distribution/verified-release.test.mjs --maxWorkers=2
```

The new suite contains nine tests, including a sequential sixteen-profile
build matrix. Existing release-input and release-verifier tests exercise the
unchanged consumer defaults. At most two assemblies run concurrently. No full
distribution, server, browser deployment or hardware test ran in this slice.

The standalone validator's generator-evidence regression failed before the
correction with `Missing expected exception`: replacing the captured generator
with one zero byte and updating its descriptor digest had been accepted. The
shared verification now compares generator bytes against the implementation
captured at module initialization on every validation, including standalone
calls. The same regression passes after the correction. This remains a
synchronous consistency check; it does not reassemble supplied evidence.

For browser qualification, the test process can retain its already-built
artifacts when `TRIPTYCH_TWO_MIB_FIXTURE_ROOT` names a fresh `mktemp -d` directory.
Each `nNN` subdirectory receives `descriptor.json`, `system.bin` and
`bootstrap.bin`. The test rejects existing profile directories and uses
exclusive file creation, so it never replaces earlier captures. This optional
test-output hook does not change the production builder interface.

## Limits and next proof

Hashes establish integrity and detect mixed inputs; they are not signatures.
Validation compares captured assembly bytes and inspects selected machine
invariants. It is not a proof of arbitrary replacement code or rehashed label
maps. Local Git/source reads assume no concurrent hostile filesystem mutation.

Never run this fresh-release verifier against saved resident records. v4
reopening and checkpoints preserve guest-modified bytes. Adjacent counts have
identical bootstraps, so v4 cannot establish a saved image's historical BIOS
identity after a consistent paired profile relabelling. The next task is
browser descriptor admission and recovery integration, followed by the full
tool-lifetime and transaction qualification gates. These host tests establish
no ESP32 memory or timing result.
