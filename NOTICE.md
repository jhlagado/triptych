# Project provenance

Triptych began as an uncommitted architecture experiment in the Debug80
worktree at revision `6db2538d`. The CPU, video, and sound contracts, reference
models, tests, ROM sources, and proof report moved into this repository on
2026-08-26. Debug80 retained none of the machine-specific files or exports.

The project-owned code is distributed under GPL-3.0-or-later. The optional
tests use `@jhlagado/debug80-runtime` and `atom-z80` as development tools;
those packages remain separately maintained dependencies. AZM is not a normal
build or test dependency. CP/M and CP/Mish
artifacts require their own provenance and licence records before they are
vendored or distributed here.

`third_party/cpm22/cpm22.img` is a transitional demonstration disk distributed
under the CP/M grant recorded beside it. Its provenance record identifies the
exact source revision, artifact digest, and licences of the additional Atom,
Nucleus, and Debug80-authored files. The hosted Triptych system replaces the
image's BIOS with the current Triptych BIOS before execution.

The optional native working-disk proof accepts Atom's external
`atom-cpm22.com` artifact and example source only after matching their pinned
SHA-256 digests. Atom is GPL-3.0-only and remains outside this repository; the
proof reports its repository, licence, and artifact digest rather than
silently copying it into Triptych.

The independently released CCP/BDOS and NUC inputs under
`third_party/portable-cpm/` and `third_party/nucleus/` include their upstream
manifests, licences and immutable source provenance. They prepare the fresh
distribution migration; the retained demonstration fixture is unchanged.
