# Pinned distribution consumer integration

2026-09-05. This checkpoint covers local integration, not hosted acceptance or
ESP32 measurements. It follows [first boot](pinned-distribution-first-boot.md).

Browser and native defaults now use the component-locked fresh distribution.
It contains the released Portable CP/M residents, ATOM, NUC and Edit, plus
Triptych BIOS and versioned sample sources. Adding `LARGE.ASM` for scrolling
tests gives the disk SHA-256
`90afb240503a95b14620a9f829c8c9a63a4ba78798e4327bc16313639454a710`.
Saved native disks retain their application and user records during resident
refresh. An explicit external image remains a development override.

The old `roms/cpu/ccp/ccp.asm` and `roms/cpu/bdos/bdos.asm` copies are removed.
Integration proofs prepare the pinned upstream snapshots with the released
Triptych profile, verify raw and prepared-source hashes, and require ATOM's
output to equal the published residents. Independent review reproduced both
binaries, 98 BDOS tests and the revised source-bearing scenario disk hashes.
The snapshots are test inputs, not another development authority.

## Review findings and verification

The first browser run after migration exposed a test-validity problem during
independent review: the local server still served the historical disk. Those
seven passing tests were not evidence for the new distribution. The corrected
server serves built assets by default. A new HTTP test hashes the served disk
and configuration against the deployment manifest. All eight browser tests
then passed against the new disk.

The browser builder stages output privately and preserves the prior output on
failure. Independent injected-failure probes covered Cargo, bindgen, input,
asset and publication failures, including a failed restoration that retains a
recoverable backup. The deployment checker validates revision, release dirtiness,
asset inventory and digests, resident slots and bootstrap identity. Eleven
synthetic CLI tests cover corruption and invalid manifests.

The full `npm run check` passed with AZM imports forbidden: 274 Vitest tests,
CCP boundary/failure/stack proofs, fresh-distribution guest compilation and
editing, eight browser tests, native PTY termination/restoration tests and the
Rust checks. The native adapter received separate independent review and five
focused tests. These are macOS/host proofs, not Linux or physical-device results.

CI now rebuilds with `--release`, validates the exact source revision, runs
browser acceptance without rebuilding, and uploads that output. Pull requests
test but do not deploy. A green clean-release CI run and verification of the
downloaded Pages assets and application session remain required before hosted
acceptance is complete.
