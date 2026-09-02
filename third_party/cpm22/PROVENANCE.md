# Transitional CP/M 2.2 demonstration disk

## Artifact

- File: `cpm22.img`
- Bytes: 256,256
- SHA-256: `7d2898386a77ff3c1e84b0141dad251a19be795befadb7dd8a9ba5965ba4654f`
- Original imported SHA-256:
  `51b61f8c8d26a252890b08e78627ba82e1bd92b2dc4a640fd6b64201aa5cb6be`
- Source repository: https://github.com/jhlagado/debug80
- Source commit: `2cb5cb6138ac7864b0c97ea32482f617de97da97`
- Source path: `apps/debug80-vscode/roms/cpm22/cpm22.img`
- Build recipe: `scripts/cpm22/build-image.mjs` at the same source commit
- Imported into Triptych: 2026-09-02

The digest is checked whenever Triptych builds the browser host. This is a
transitional development image, not the intended final Triptych system disk.
The hosted runtime copies the disk into memory and installs the current
Triptych BIOS over its system-track BIOS slot before executing it.

Triptych subsequently normalized the line endings in `INPUT.ASM`, `HELLO.ASM`,
and `LARGE.ASM` from Unix LF to CP/M CRLF. The reproducible transformation is
`npm run normalize:cpm22-text`; `npm run check:cpm22-text` checks every bundled
text file for ASCII, CRLF line endings, and `$1A` record padding. This changed
only the three named directory files and their allocation records; the system
track and executable components retain the imported bytes and hashes.

## Components

- The CP/M 2.2 CCP and BDOS are Digital Research derivatives distributed under
  the Bryan Sparks grant in `LICENSE.txt`. Their converted source and
  conversion record are under `third_party/cpm22/` in the source repository at
  the commit above.
- `ATOM.COM` is the GPL-3.0-only Atom Z80 assembler from `packages/atom/` in the
  source repository. Its artifact SHA-256 is
  `cdd5d05e3131b23288914b354929cfb5c2e1639d71c35f337e8fcec8c2bdfcbb`.
- `NUC.COM` is the GPL-3.0-only Nucleus native CP/M compiler from
  https://github.com/jhlagado/nucleus at commit
  `79016539569aaffe66334cf350f9b9100a5a8bb4`. Its artifact SHA-256 is
  `7b3da3c0b595a88b4906537fe0f76c44f7abd412e248d35d927d1aefd8971ef1`.
- `SMOKE.COM`, `EDIT.COM`, the example sources, and the original disk BIOS and
  bootstrap were generated from GPL-3.0-or-later Debug80-owned sources by the
  recorded build recipe. The original BIOS is replaced by Triptych at runtime.

The disk still contains a historical `README.TXT` identifying its Debug80
origin. This is intentional provenance rather than the identity of the hosted
machine.
