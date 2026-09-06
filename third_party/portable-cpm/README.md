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
