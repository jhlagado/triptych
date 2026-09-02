# Project provenance

Triptych began as an uncommitted architecture experiment in the Debug80
worktree at revision `6db2538d`. The CPU, video, and sound contracts, reference
models, tests, ROM sources, and proof report moved into this repository on
2026-08-26. Debug80 retained none of the machine-specific files or exports.

The project-owned code is distributed under GPL-3.0-or-later. The optional
tests use `@jhlagado/debug80-runtime` and `@jhlagado/azm` as development tools;
those packages remain separately maintained dependencies. CP/M and CP/Mish
artifacts require their own provenance and licence records before they are
vendored or distributed here.

The optional native working-disk proof accepts Atom's external
`atom-cpm22.com` artifact and example source only after matching their pinned
SHA-256 digests. Atom is GPL-3.0-only and remains outside this repository; the
proof reports its repository, licence, and artifact digest rather than
silently copying it into Triptych.
