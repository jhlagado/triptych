# Two-MiB Portable CP/M release consumer

Date: 2026-09-07. Status: retained-input validation and the all-profile
Triptych ATOM rebuild gate passed. Browser activation remains pending.

The new consumer family retains Portable CP/M 0.1.4 at
`d28fc52774c967d1422b3b814d51c069247504c1`, with sixteen independent target locks.
[Retained-input provenance](../../third_party/portable-cpm/2m/v0.1.4/README.md)
records the public asset, hashes, source, licence and upstream CI evidence.
The existing default and eight-MiB A/B locks and retained files are unchanged.

`portable-cpm-source.mjs` validates repository-retained component bytes,
provenance, exact manifest identity, raw source and generated source before
assembly. Two-MiB locks additionally require the fixed geometry, CCP/BDOS pair,
shared manifest and exact released revision. `distribution-manifests.mjs`
checks each named origin, entry, installation range and release version.
No consumer path fetches inputs or discovers a sibling checkout.

The lightweight test file is
`test/distribution/two-mib-release-inputs.test.mjs`. It covers every profile,
historical profile preparation, malformed names, tampered binary/source/
provenance/manifest/lock data, and missing retained inputs beside an available
sibling checkout. The n01/n02 substitution case preserves matching binary
hashes and updates the manifest provenance hash, so rejection must come from
the wrong profile identity rather than an unrelated digest failure.

The new 32-case input suite and the existing component-lock, verified-release
and distribution-manifest suites passed together: 125 tests across four files.
These checks perform no Z80 assembly. Scoped formatting and prose checks
also passed.

`test/distribution/two-mib-release-assembly.test.mjs` is the separate,
heavier gate: ATOM rebuilds CCP and BDOS for all sixteen profiles and compares
every output byte with the release. The integrated input and assembly gates
passed together at Triptych `569d51d`: 48 tests across two files in 47.63 seconds,
using `VITEST_MAX_WORKERS=2` on macOS. This is the consumer rebuild evidence,
separate from upstream release verification.

```sh
VITEST_MAX_WORKERS=2 npx vitest run \
  test/distribution/two-mib-release-inputs.test.mjs \
  test/distribution/two-mib-release-assembly.test.mjs
```

This change does not construct Triptych system images, define runtime
descriptors, admit browser profiles or alter native launching. BIOS/bootstrap
integration, complete tool-lifetime qualification, deployment and recovery
admission remain separate stages of the
[two-MiB roadmap](../plans/two-mib-configurable-drives.md).
