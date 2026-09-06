# Portable CP/M release inputs

CCP and BDOS are from
[`jhlagado/portable-cpm` v0.1.2](https://github.com/jhlagado/portable-cpm/releases/tag/v0.1.2),
commit `2adfb035ec4de9a3a6dc629677fc8a0072cf0f74`.
The source and build tools are available at that immutable upstream revision.
The copied licence is GPL-3.0-or-later, as declared by the upstream package.

The two provenance JSON files bind each downloaded executable to the revision,
release asset URL and exact upstream manifest bytes. The artifacts were
published from passing Linux CI run 34031062227 and downloaded again for
verification. Neither executable contains the Triptych BIOS.

The host distribution builder consumes these pinned inputs. Version 0.1.2
adds DSM bounds checks before BDOS allocation-vector indexing and record-address
conversion. CCP bytes and the resident memory profile are unchanged from 0.1.1.
Source snapshots were copied from the exact upstream commit and
verified against the raw release manifest, then assembled with ATOM to check
source/binary identity. Triptych does not maintain a second authoritative copy.

## Separate A/B resident inputs

The `8m-ab/` directory contains the separately named
`triptych-cpu-v0.1-8m-ab` profile from
[Portable CP/M 0.1.3](https://github.com/jhlagado/portable-cpm/releases/tag/v0.1.3),
commit `c2b64f013f0a96d015f7aaa7a2c35183579a9559`.
Its CCP begins at E300 and BDOS at EB00. These files do not replace the default
0.1.2 inputs above or authorize changing an existing disk.

Both release profiles passed Linux main CI run
[34036247020](https://github.com/jhlagado/portable-cpm/actions/runs/34036247020).
The A/B ZIP was downloaded from the published release and compared byte for
byte with the retained CI artifact. Each local provenance file identifies that
ZIP, the exact manifest digest and the component digest. Source snapshots match
the release's raw and prepared-source hashes; the Triptych proof rebuilds them
with ATOM and compares every output byte with the released binaries.

[The separate resident lock](../../distribution/residents-8m-ab.lock.json)
selects these inputs. Version 0.1.3 corrects explicit FCB drive selection,
default-drive queries, login and allocation-vector reset. The licence remains
GPL-3.0-or-later; the licence copy in this directory applies to both profiles.
