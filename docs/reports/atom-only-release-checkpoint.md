# ATOM-only release checkpoint

2026-09-05. This is a local toolchain checkpoint under S1 of the
[software stability roadmap](../plans/software-stability-roadmap.md), not a
published Triptych distribution.

ATOM branch `range-and-bootstrap` now includes these local commits:

- `d08a900`: two-generation ATOM native-core bootstrap;
- `6beb7d0`: ATOM native-object builder;
- `7e00661`: ATOM CP/M image and output-size measurement builders;
- `b89714d`: retirement of the live AZM test oracle and package dependency.

At the last checkpoint, `npm run release:check` passed all 358 tests with
AZM imports blocked, followed by native-host and self-host measurements. The
package installed offline without AZM and ran from an unrelated directory.
The package census passed separately: 397 entries, 2,219,145 unpacked bytes.
The resident binaries remained unchanged. Source converters remain available
without executing AZM.

Independent comparison data was preserved by one isolated historical-oracle
capture before removing the dependency. ATOM's test-only fixture records
6,788 requests, with source-revision and historical-package digests. Unknown
reference requests fail rather than deriving expected answers from ATOM.
The detailed provenance and commands are in the ATOM repository's
`docs/reports/atom-reference-retirement.md`.

Triptych's guarded `npm run check` passed on macOS with its unchanged ATOM
pin, `27b32ad97ee0596d1952617261b644f8ccc389f9`. This does not qualify the
unpublished ATOM revision as a Triptych dependency. Neither repository's
checkpoint was pushed during this work.

S1 remains incomplete. ATOM's final-byte output boundary still prevents the
remaining Nucleus relocation proof. Nucleus reconciliation, clean component
release qualification and downstream pin updates follow that correction.
There was no new Pages, Linux, mobile-device or ESP32 hardware qualification.
