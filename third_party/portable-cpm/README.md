# Portable CP/M release inputs

CCP and BDOS are from
[`jhlagado/portable-cpm` v0.1.0](https://github.com/jhlagado/portable-cpm/releases/tag/v0.1.0),
commit `579657f9177b31e1fccf0c05f72ba2ee76f3d052`.
The source and build tools are available at that immutable upstream revision.
The copied licence is GPL-3.0-or-later, as declared by the upstream package.

The two provenance JSON files bind each downloaded executable to the revision,
release asset URL and exact upstream manifest bytes. The artifacts were
published from passing Linux CI run 33932175767 and downloaded again for
verification. Neither executable contains the Triptych BIOS.

These inputs prepare the distribution migration. Until that migration passes,
their presence here does not mean the current host builder consumes them.
