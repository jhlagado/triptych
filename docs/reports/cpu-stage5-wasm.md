# Triptych CPU Stage 5 WASM report

Status: passed

Date: 2026-08-31

Interactive terminal added: 2026-09-01

ANSI screen profile added: 2026-09-01

## Outcome

`triptych-host-wasm` is a headless JavaScript-facing adapter over the unchanged
portable CPU core. It exposes construction, reset, bounded run slices,
instruction stepping with the proven `$FF` interrupt, serial queues, complete
disk-image import/export, RAM access, CPU snapshots, and ordered full-port I/O
observations.

The adapter owns copied Rust buffers and retains no JavaScript callback or
object during execution. It has no DOM, browser storage, wall clock, worker,
filesystem, terminal, ESP-IDF, or Debug80 dependency.

## Conformance proof

The proof compiled the crate for `wasm32-unknown-unknown`, generated Node.js
bindings with exactly `wasm-bindgen` 0.2.127, and drove the resulting WebAssembly
module from JavaScript. All six language-neutral fixtures matched their complete
expected result objects and canonical SHA-256 digests:

- `boot-overlay-serial`;
- `cold-boot-disk-persistence`;
- `flags-conditional-timing`;
- `interrupt-im1`;
- `reset-defined-state`;
- `serial-read-order`.

The conformance build uses a non-default feature to dirty requested
architectural CPU fields immediately before reset. This follows the fixture
protocol without adding arbitrary CPU mutation to the ordinary WASM API.

## CP/M proof

The proof used the same external provenance-reviewed CP/M 2.2 image and
Triptych bootstrap and BIOS sources as the native milestone. The image remains
outside the repository.

The first WASM machine cold-booted CP/M, ran `SMOKE.COM`, and created and
flushed `RESULT.TXT`. JavaScript exported the resulting disk bytes, destroyed
the machine, and installed those bytes in a fresh WASM machine. The second
machine cold-booted and printed the file through `TYPE RESULT.TXT`:

```text
CP/M file services are working
```

Both serial transcripts matched the native proof's expected transcripts.

## Interactive browser terminal

On 2026-09-01, the ordinary WASM build was regenerated with the pinned macOS
arm64 `wasm-bindgen` 0.2.127 binary and served from `127.0.0.1`. The browser
loaded the current external CP/M compatibility image with SHA-256
`6313a5ea94f9e8bb48acf0f99e51e6432a9a1ce61e9f0c785f5e17b287b7dd7f`.
This is a later Debug80 development image, not the historical `b5c95e…` image
used by the original Stage 5 proof.

The in-app browser reached `A>`, accepted individual key events, and produced
the expected results for:

```text
DIR
SMOKE
TYPE RESULT.TXT
```

`SMOKE.COM` reported `Wrote RESULT.TXT`; `TYPE` printed `CP/M file services are
working`. Reset cold-booted to a fresh prompt, and a second `TYPE RESULT.TXT`
read the flushed file from the retained in-memory disk. Selecting the same disk
through the file picker also produced a fresh `A>` prompt. The page reported no
browser console errors during these checks.

The working-disk control calls the already-proved WASM disk export and creates
a standard browser download. The in-app browser did not expose a download event
to its test harness, so this report does not claim that a saved file was
observed through that browser's download manager.

## ANSI screen proof

The browser UI now owns a bounded 80-column by 24-row cell matrix rather than
an append-only text log. Its parser covers printable 7-bit ASCII, bell,
backspace, tab, separate carriage return and line feed, delayed wrap,
bottom-margin scrolling, cursor movement and positioning, display and line
erase modes 0, 1, and 2, and bold, underline, and reverse-video rendition.
Unsupported or overlong escape sequences are consumed rather than displayed.
Arrow-key events enqueue the corresponding three-byte ANSI sequences; the
serial ports, WASM adapter, and portable CPU core are unchanged.

Focused checks exercised fragmented CSI input, every supported control family,
per-cell attribute clearing, screen bounds, scrolling, the complete editor
repaint shape, and arrow-key encoding. A live in-app browser then cold-booted
the regenerated ordinary WASM bundle and ran `EDIT.COM`. The resulting DOM had
exactly 24 rows, showed `sub main() fails` on row 1 and the reverse-video
`EDIT INPUT.NU` status on row 24, placed the cursor at row 1 column 1, and
contained no literal `[24;1H`, `[7m`, `[0m`, or `[2J` fragments. Right Arrow
moved the guest editor cursor to column 2 and Left Arrow returned it to column

1. This proves the browser host model and input path, not an ESP32 terminal or
   physical serial link.

## Reproduction

```sh
WASM_BINDGEN=/path/to/wasm-bindgen \
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img \
npm run proof:wasm-host
```

The interactive path uses the same inputs:

```sh
WASM_BINDGEN=/path/to/wasm-bindgen \
TRIPTYCH_CPM22_IMAGE=/path/to/cpm22.img \
npm run run:wasm-browser
```

The pinned CLI binary used for this run was `wasm-bindgen 0.2.127`; its macOS
AArch64 release archive matched published SHA-256
`cd93e691eb5953ace5d8ffce52a20b024077a3dac3e2215b8224136b0efb7585`.

## Claims not made

- The retained conformance proof still executes headlessly through Node.js;
  the browser run covered the interactive CP/M path rather than repeating all
  six fixtures in a browser page.
- The adapter makes no claim about Web Worker scheduling, clock-accurate
  animation pacing, IndexedDB durability, or long-session browser stability.
- This is host-model evidence. It does not measure or imply ESP32 behaviour.
- VDP and sound remain inert because those modules are outside the CPU Stage 5
  host.
