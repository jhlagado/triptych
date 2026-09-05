# Hosted pinned-distribution acceptance

2026-09-05. The hosted browser proof passed for Triptych revision
`33b94a72d609a3a53b1efb76c31e2aa9789f99af` at
[GitHub Pages](https://jhlagado.github.io/triptych/).
The tested reference was the downloaded `github-pages` artifact from successful
[CI run 33935907910](https://github.com/jhlagado/triptych/actions/runs/33935907910),
not a local rebuild. Its distribution manifest records a clean source tree.

All 17 assets matched their declared lengths and SHA-256 digests. The hosted
manifest matched the downloaded CI manifest byte-for-byte. Chromium's actual
navigation, modules, configuration, disk and bootstrap responses were also
checked against that manifest, including responses during reload.

An isolated browser context compiled and ran `HELLO.ASM` with ATOM, edited
`INPUT.NU`, saved and compiled it with NUC, and ran the modified output. Reload
restored the working disk; reopening the edited source and rerunning its saved
executable passed. No user's existing browser storage was used. The initial
disk SHA-256 was
`90afb240503a95b14620a9f829c8c9a63a4ba78798e4327bc16313639454a710`.

The preceding run, 33935518230, had green build/deploy jobs but failed downloaded
artifact verification: the upload action excluded `.nojekyll`. The correction
enabled hidden-file inclusion for `dist/wasm-browser`. A focused regression
failed before that change and passed afterward; the corrected downloaded tar
and hosted file were both verified. No file was added manually to the reference
artifact to obtain the passing result.

The repeatable command is:

```sh
node tools/prove-hosted-browser.mjs https://jhlagado.github.io/triptych/ /path/to/extracted-ci-artifact 33b94a72d609a3a53b1efb76c31e2aa9789f99af
```

This is revision-specific hosted evidence. It does not certify later deployments,
physical mobile keyboard behavior or ESP32 hardware. Linux execution of the
new native/WASM parity gate and remaining Debug80 consumer changes are separate
outstanding roadmap items.
