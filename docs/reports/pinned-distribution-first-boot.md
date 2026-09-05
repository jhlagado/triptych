# Pinned distribution first boot

2026-09-05. The first fresh distribution builds from
`distribution/components.lock.json`: Portable CP/M CCP/BDOS v0.1.0, the local
Triptych BIOS, ATOM at `802b5c2`, Nucleus v0.3.0 and Edit v0.1.1. The bootstrap
is local machine code. No inherited application or disk image is an input to
this builder.

The builder returns private disk and bootstrap buffers plus an output manifest.
It does not publish files or update saved disks. It requires a clean checkout
by default; explicit development builds record the Git revision and dirty flag.
Installed ATOM JavaScript still requires the clean `npm ci` gate: seed/image
digests do not authenticate arbitrary installed JavaScript changes.

The unpatched current ATOM guest is 15,033 bytes. Its declared workspace ends
at E400, below the resident CCP. The lock's seed digest identifies the raw
64,236-byte native-core JSON envelope, not ATOM's internal HEX/symbol hash.
The historical self-assembly retargeting recipe remains separate and cannot
patch this new image without further qualification.

Independent review reproduced an ATOM repository attribution flaw in the
initial builder. The corrected builder requires the canonical repository and
the complete installed-lock dependency identity. Regression tests reject both
the forged selected repository and a mismatched installed repository.

Two builds produce identical disk/manifest content. The standalone WASM proof
boots that disk, assembles HELLO.ASM with current ATOM and runs it, compiles the
default INPUT.NU with current NUC and runs OUTPUT, edits and saves NEW.NU,
exports the working disk, boots a fresh machine, compiles/runs NEW and reopens
the saved source in Edit. The first passing disk digest is
`6825f499073fcb72d85217ca016dd43564144900f5b85b6575ce31f623b88910`.

Run `npm run proof:cpm-distribution` in a clean checkout, or
`npm run check:cpm-distribution` for an explicitly development-marked build.
The latter is included in the full repository check. This is a headless WASM
execution proof, not an IndexedDB, native filesystem, mobile or ESP32 proof.

The combined `npm run check` passed locally with AZM imports blocked: 258
Vitest tests, the new fresh-distribution proof, seven existing browser tests,
both native PTY paths, resident-system checks and Rust checks/builds. Existing
browser and PTY tests still use the previous default image path; their success
does not substitute for testing the upcoming default migration.

The browser and native default image builders have not switched to this new
distribution yet. Next: migrate those consumers, preserve historical oracle
scenarios, run native/browser persistence acceptance against the same disk,
and publish only that verified artifact set.
