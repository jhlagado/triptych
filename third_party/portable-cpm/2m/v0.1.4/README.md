# Portable CP/M 0.1.4 two-MiB release inputs

These CCP and BDOS binaries, manifests and source snapshots are from
[Portable CP/M v0.1.4](https://github.com/jhlagado/portable-cpm/releases/tag/v0.1.4),
commit `d28fc52774c967d1422b3b814d51c069247504c1`.
The upstream package declares GPL-3.0-or-later; the unmodified upstream
[licence](LICENSE) is retained here. Triptych does not maintain a separate
authoritative CCP or BDOS implementation.

The published asset is
[`portable-cpm-triptych-cpu-v0.1-2m.zip`](https://github.com/jhlagado/portable-cpm/releases/download/v0.1.4/portable-cpm-triptych-cpu-v0.1-2m.zip),
75,121 bytes, SHA-256
`30b96c91993db526331367543f3951959c14200ea03d55bccc40651faa015649`.
It contains exactly three files for each of the sixteen named profiles:
`ccp.bin`, `bdos.bin` and `manifest.json`.
The public release was redownloaded and compared byte-for-byte with the
retained Linux CI artifact and fresh local builds. The release tag resolves to
the commit tested by
[Linux run 34068547951](https://github.com/jhlagado/portable-cpm/actions/runs/34068547951).
The annotated tag is unsigned.

Each component's provenance file binds its binary and manifest hashes to that
release URL and source revision. The common `src/` files match the manifests'
raw source hashes. The consumer reconstructs the profile-specific ATOM EQU
preamble and checks its prepared-source hash. Its assembly helper additionally
compares every rebuilt byte with the retained released binary.

The [n01 lock](../../../../distribution/residents-2m/n01.lock.json) and its
fifteen siblings select these inputs. Odd/even profile pairs share resident
origins and binary bytes but retain distinct manifest identities. Supplying
the n02 manifest for n01 is invalid even when both binaries match.

This family leaves the historical default and eight-MiB A/B pins unchanged.
Normal consumption uses only repository-retained inputs, with no network fetch
or sibling-checkout fallback. These files do not include a machine BIOS or
bootstrap and do not authorize rewriting saved disks.
