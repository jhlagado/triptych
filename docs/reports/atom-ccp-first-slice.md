# Atom CCP first vertical-slice checkpoint

Status: host-model prompt, parser, transient, `DIR`, and `TYPE` checkpoint

Date: 2026-09-03

## Result

Triptych now has an original Atom-compatible CCP source at
`roms/cpu/ccp/ccp.asm`. It assembles to the fixed 2,048-byte
`$E400..$EBFF` image and does not depend on legacy CCP source or internal
symbols. Production image preparation still retains the transitional CCP; the
new implementation is selected only by headless fixtures or the explicit
native development preview.

The first vertical slice implements:

- cold and warm entry with reconstructed Triptych BDOS state;
- the current-drive prompt, empty lines, lowercase normalization, and the
  current-drive `A:` command;
- deterministic missing-command diagnostics;
- `.COM` lookup, complete-record loading from `$0100`, a protected oversize
  scratch read, default DMA restoration, and warm return;
- uppercase command-tail publication and both default FCBs; and
- the read-only `DIR` and `TYPE` built-ins through public BDOS calls.

The implementation currently has SHA-256
`618ecfb78b81e8c65f9699d124450daae76efa4b283f25b823f8c35fcaf6c7f7`.
This digest is a development checkpoint and is expected to change as the
remaining built-ins are added.

## Differential evidence

The repository's scenario format now selects CCP and BDOS independently with
`systemCcp` and `systemBdos`. Test-only transient probes can be assembled from
repository-owned source and installed into each private scenario disk with a
pinned byte length and digest.

`pagezero.asm` exposed three differences in the first attempt: it omitted the
tail's leading space, wrote a CR rather than zero after the tail, and placed a
short first name's extension at a variable rather than fixed FCB offset. The
corrected oracle and Triptych runs now have the identical 138-byte transcript
SHA-256
`6523f93e882942a32f7fe9ab37e7f069d58c371df51221599f3236de10f0a472`.
The probe returns with an ordinary Z80 `RET`, proving the zero warm-boot return
address supplied by CCP.

The transient smoke pair gives the oracle and replacement the same empty-line,
`A:`, missing `NOPE`, and lower-case `smoke` interactions. Both produce the
same 64-byte transcript SHA-256
`a92760fc7e4f2ab4c82a3a12891dcf62747566e4127b5407459ffb73f0a91346`
and the same 128-byte `RESULT.TXT` SHA-256
`82c956e1df9917a965b49b85106feadf27381082ccc03d9fa3e5fc651f5cded3`.
Complete disk digests differ because their resident CCP system tracks are
intentionally different.

The Triptych `DIR`/`TYPE` scenario reproduces the existing oracle transcript,
terminal text, cursor, and screen digest exactly. The complete transcript
SHA-256 is
`c4d2e133367e776360ded12178590ae0d6b7fa1386b63c41632c07249fcd51e6`.

The default headless run passed all earlier BDOS/application scenarios plus
the new CCP scenarios. These are WASM host-model results, not ESP32-S3
measurements.

The native Rust proof then selected `systemCcp: triptych`, ran `SMOKE.COM` in
one process, and booted a second fresh process to read `RESULT.TXT` with the
new `TYPE`. The starting working-image SHA-256 was
`05a4e60c636fae511c75613c92b5d78798f6b596afa9a351da53faf474a20636`.

## Current resident account

| Account                         | Range          | Bytes |
| ------------------------------- | -------------- | ----: |
| Code and immutable strings      | `$E400..$E74E` |   847 |
| Mutable workspace and load page | `$E74F..$E87F` |   305 |
| Private stack reservation       | `$E880..$E8AF` |    48 |
| Unused resident bytes           | `$E8B0..$EBFF` |   848 |

The 48-byte stack is a reservation, not yet a measured peak. Final acceptance
requires stack instrumentation across every success, recovery, and fatal
path. The load scratch page is counted as resident workspace rather than
hidden in the TPA or host.

## Development preview

On macOS or Linux, `npm run run:ccp-native` builds the Rust host and installs
the Triptych CCP, BDOS, and BIOS into a disposable disk copy. The source disk
is unchanged. The preview is deliberately rejected for persistent working
disks until the completeness matrix is closed.

## Next checkpoint

Add generated exact-limit and oversized COM fixtures, absent-drive recovery,
and malformed-command probes. Then implement and differentially prove `ERA`,
`REN`, `SAVE`, and `USER` before changing any production image builder.
