# Additive two-MiB deployment assets

Date: 2026-09-07. Status: packaging changes and focused deployment/recovery
verification pass. A complete browser build, served-module proof and application
activation were not run in this slice.

The [selected design](two-mib-system-admission-design.md) requires all sixteen
profiles in a configurable-drive release while allowing historical deployments
to omit their metadata. The browser builder now stages that family separately
from the two historical `diskProfiles` rows. Existing default disk, residents,
bootstrap, tools, configuration and eight-MiB asset meanings remain unchanged.

## Packaging

[build-wasm-host.mjs](../../tools/build-wasm-host.mjs) calls the
[fresh system builder](two-mib-system-builder.md) once per count, in order
1–16, inside the existing private browser staging directory. It writes each
tuple before moving to the next and retains only descriptors after that
iteration. Assembly evidence is not serialized into served assets. No
unbounded all-profile assembly fan-out was added.

The deployment adds:

- `twoMibProfiles`: the sixteen closed `triptych-two-mib-system-v1` descriptors;
- sixteen `system-triptych-cpm-2m-nNN-v1.bin` assets, each 16,384 bytes;
- sixteen `bootstrap-triptych-cpm-2m-nNN-v1.bin` assets, each 256 bytes;
- `two-mib-system.js` and its browser dependency, `drive-set-v4.js`.

The new binary payload totals 266,240 bytes. Every file enters the existing
sorted asset inventory with its length and SHA-256. Descriptor names remain
distinct even where adjacent profiles have identical bootstrap bytes. The
deployment schema stays `triptych-browser-deployment-v1`.

Every tuple must match the default distribution's Triptych revision, dirty
status and ATOM lock identity. All sixteen must also agree on ATOM package
integrity and raw generator, BIOS, bootstrap, CCP and BDOS source identities.
Profile-specific prepared sources, locks, manifests and output bytes keep their
separate identities. Release builds pass `allowDirty: false` to every builder.

The existing staging publication and restoration logic is unchanged. Errors
while building or writing a new tuple occur before the previous output is
moved. This is a source-level observation in this slice, not an executed
publication-fault test.

## Verification modes

[check-browser-deployment.mjs](../../tools/check-browser-deployment.mjs) retains
its existing historical checks. An absent `twoMibProfiles` collection remains
valid. A present collection must contain at most sixteen distinct valid counts;
subsets, including an empty availability registry, are permitted in ordinary
verification. Its two browser modules must be listed and present.

Each supplied tuple passes through the same bounded `fetchTwoMibSystem` path
used by the browser, with a local-file `Response` adapter. The checker then
requires complete outer source/ATOM identity and common family provenance.
The ordinary inventory checks still reject missing, extra or differently hashed
files before success is reported.

Current configurable-drive release gates must additionally use:

```sh
node tools/check-browser-deployment.mjs dist/wasm-browser REVISION --release --require-two-mib
```

`--require-two-mib` requires exactly counts 1 through 16; it does not change
historical acceptance when absent. Workflow, package and hosted-proof gate
wiring belong to the coordinator and were not edited by this slice.

Recovery archive behavior and its receipt schema are unchanged. The generic
archive copier already retains every listed file and the exact manifest.
New tests prove that it carries the complete profile family and rejects its
corruption. The receipt still reports `triptych-drive-set-v3` and runtime
qualification `not-performed`: adding assets does not turn the current
application into a qualified v4 recovery client.

## Focused evidence and next gate

The deployment and recovery suites use an independent synthetic fixture that
imports no production builder, profile generator or assembler. Those fixtures
exercise descriptor, binary-layout and archive validation; they are not
bootable machine or release-provenance evidence. Historical success and failure
fixtures remain in the same suites.

```sh
npx vitest run test/distribution/browser-deployment.test.mjs test/distribution/browser-recovery-archive.test.mjs --maxWorkers=2
node --check tools/build-wasm-host.mjs
node --check tools/check-browser-deployment.mjs
```

The two Vitest suites passed 123 tests in 13.44 seconds with at most two
workers. Both syntax checks and the whitespace/diff check passed.

Coverage includes all sixteen counts, incomplete and duplicate families,
malformed unselected descriptors, missing runtime/dependency modules despite a
consistent inventory, source/ATOM mismatches, mixed raw-source identities,
neighboring BIOS substitution with updated hashes, component corruption and
nonzero reserved tails. Archive tests compare every retained asset exactly and
verify failure before destination reservation.

The next gate is a coordinated clean browser build, complete-family checker,
and import/fetch proof against the actual served modules. The previously
captured all-profile browser API gate proves builder/API agreement but does
not establish this packaging path. Application creation/reconfiguration,
v4 persistence/recovery activation, hosted qualification and ESP32 measurements
remain separate work.
