# Software release evidence checkpoint

2026-09-05. S0–S5 have supporting release and execution evidence. Debug80's
installed-package CI passed and its integration is merged. S7 remains open
for final publication and the cross-project audit. Earlier reports describe their
own revisions and are not current-status declarations.

Triptych `9a90180988e4ca1b5c8c38dc2b244b11459b65bd` passed clean Linux
[CI run 33936209576](https://github.com/jhlagado/triptych/actions/runs/33936209576),
including the full check, complete headless replay, native PTY tests, native/WASM
parity and final browser acceptance. Both parity sessions produced disk digest
`d148fbbe2f6b57258bb99c7390b086de5a69bbd7d9071ddc0993297b7c31c37c`,
matching the macOS measurements.

The downloaded CI artifact and actual hosted browser responses matched all
17 assets. ATOM compilation/execution and Edit/NUC save/reload/reopen/execution
passed on the hosted page. The clean initial disk digest is
`90afb240503a95b14620a9f829c8c9a63a4ba78798e4327bc16313639454a710`.
Two clean local builds at the same revision produced identical manifests,
bootstrap bytes and disk bytes.

## Distribution census

The Rust `triptych-cpm list` validator checked the downloaded disk's extent
sequences and allocation references. It reported:

| File      | Stored records | Stored bytes |
| --------- | -------------: | -----------: |
| ATOM.COM  |            118 |       15,104 |
| NUC.COM   |            167 |       21,376 |
| EDIT.COM  |             25 |        3,200 |
| HELLO.ASM |              1 |          128 |
| INPUT.NU  |              1 |          128 |
| LARGE.ASM |             17 |        2,176 |

Free space is 196 allocation blocks, or 200,704 bytes, with 57 free directory
entries. Stored file sizes include record padding. Each sample matched the
versioned CRLF source exactly, with only `0x1A` EOF padding afterward.

## Component evidence

The distribution lock pins ATOM `802b5c2`, Nucleus `52cca195`, Edit `24275017`
and Portable CP/M `579657f9`, with full revisions and digests in the lock.
ATOM's pinned `docs/reports/git-consumer-packaging.md` records guarded tests,
offline package installation and repeat-generation equality. Nucleus's
[release CI](https://github.com/jhlagado/nucleus/actions/runs/33928269180)
qualified the released source. Portable CP/M's
[release CI](https://github.com/jhlagado/portable-cpm/actions/runs/33932175767)
qualified the independent OS and alternate profile. Edit's
[release CI](https://github.com/jhlagado/edit/actions/runs/33933433991)
qualified v0.1.1. Triptych's integration proofs reproduce the pinned resident
bytes from verified upstream snapshots; BIOS remains local.

## Retained checkpoint

Debug80 [PR #9](https://github.com/jhlagado/debug80/pull/9) merged at
`7481f14403265a58ece0648412212a3e0ca58283` after
[CI 33937077504](https://github.com/jhlagado/debug80/actions/runs/33937077504)
passed CP/M acceptance, extension tests, packaging and an actual installed-VSIX
test in a private Linux profile. The equivalent installed test passed on macOS.
One initial local runner failure had no retained diagnostic; subsequent local
runs and Linux passed. The runner now retains future failure logs. The optional
workspace launcher selects the merged Debug80 pin without an AZM support edge;
all 18 launcher tests passed after that update. The
[browser quick start](../browser-quick-start.md) records the tested user session,
backup/restore procedure, command summary and supported-profile limits.

[wasm-9a90180](https://github.com/jhlagado/triptych/releases/tag/wasm-9a90180)
retains the exact CI `artifact.tar` as a prerelease rollback checkpoint. A fresh
download matched the CI archive byte-for-byte. It is
not an assertion that S6/S7 are complete. The archive contains the tested site
and deployment manifest. To inspect a retained site, extract into a new empty
directory and run `tools/check-browser-deployment.mjs` against that directory
and its full revision with `--release` before serving it.

A source redeployment can run the Pages workflow at the retained tag; it must
pass the normal checks and hosted verification again. Such a rebuild is
distinct from restoring the archived bytes. No production rollback was
performed during this checkpoint.
