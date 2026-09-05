# Portable CP/M release inputs

CCP and BDOS are from
[`jhlagado/portable-cpm` v0.1.1](https://github.com/jhlagado/portable-cpm/releases/tag/v0.1.1),
commit `b07dad632e7ef3be6528289a5a35308983964b05`.
The source and build tools are available at that immutable upstream revision.
The copied licence is GPL-3.0-or-later, as declared by the upstream package.

The two provenance JSON files bind each downloaded executable to the revision,
release asset URL and exact upstream manifest bytes. The artifacts were
published from passing Linux CI run 33996896372 and downloaded again for
verification. Neither executable contains the Triptych BIOS.

The host distribution builder consumes these pinned inputs. Version 0.1.1
moves the transient entry stack outside default disk DMA; BDOS bytes are
unchanged. Source snapshots were copied from the exact upstream commit and
verified against the raw release manifest, then assembled with ATOM to check
source/binary identity. Triptych does not maintain a second authoritative copy.
