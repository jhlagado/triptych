# Native ATOM Edit 0.2.0 integration

Triptych now consumes the standalone Edit engine with gap storage and partial
redraws. The editor remains an independently built CP/M application. Fresh
distribution images receive the pinned `EDIT.COM`; reopening saved working
media does not install newer application bytes.

## Release identity

The source is Edit revision `dbbda081b58077c98b509625176739bd9c5608ec`,
version 0.2.0. Its [Linux check](https://github.com/jhlagado/edit/actions/runs/34134268198)
passed, and the downloaded `edit-release` artifact matches the local native
ATOM build byte for byte:

| File          | Bytes | SHA-256                                                            |
| ------------- | ----: | ------------------------------------------------------------------ |
| EDIT.COM      |  5513 | `6be83f6edb9ee92387c7b3817f473fbbc389a58ab1a20d9a2a6101e695fb77c4` |
| manifest.json |   485 | `63409590ef432181362b3ee81061a9111666743a76c9088cbde9b4038298481d` |

The component lock, dedicated release verifier and both provenance files pin
the same revision and bytes. The manifest requires native ATOM source and a
matching release baseline. Triptych neither translates nor assembles Edit.
The source migration preserved the completed editor milestone's binary,
capacity and behavior; performance figures from that milestone therefore
remain applicable to the binary, with their original measurement limits.

## Integration changes

The arena observer reconstructs logical text from the occupied prefix and
suffix around the gap. It checks gap bounds and the length invariant before
comparing exact text. Rejected growth must preserve both gap words and the
entire 47,104-byte physical arena, including bytes outside logical text.
Focused negative tests cover corrupt bounds, length and suffix content, and
movement of a zero-sized gap. These tests run in the large-arena check.

The native/WASM parity proof waits for status text and the final cursor
position together. The initial cursor-positioning escape sequence alone is
not a completed editor screen. Raw output, terminal snapshots and saved-disk
comparisons remain exact.

Manual release-workflow dispatches on an integration branch retain the
qualified browser artifact. Only the main branch can configure or deploy the
live Pages site. This permits release qualification without publishing the
existing, separately reviewed two-MiB development work.

The terminal page now places “Triptych Terminal” in the main heading and
“WebAssembly” in the smaller green label. Its footer contains only the typing
and mobile-key instructions. A rebuilt browser host boots at desktop
1280×900 and mobile 390×844 sizes; both rendered headings fit and the shorter
help text matches the source.

## Memory qualification

Edit loads at 0100–1688, uses workspace 1E00–1FE9 and text 2000–D7FF,
and reserves D800–E3FF for its stack. Across the one-to-sixteen-drive two-MiB
profiles, the lowest live BDOS address is E600. Some profiles place disposable
CCP below Edit's reserved stack top. That overlap is permitted only while the
application runs; warm boot must reload CCP before it executes again.

The existing lifetime matrix includes the sixteen-drive Edit arena suite.
Its instruction observer rejects execution in disposable CCP, bounds Edit's
stack and checks resident reload before CCP entry. Checkpoints verify the
immutable BDOS region. Recorded stack minima describe exercised paths; they
are not a proof of the deepest possible stack use. BDOS writable state is
excluded from immutable-byte comparisons.

## Verification record

The focused release installation test, CP/M distribution edit/save/reboot/
compile sequence, native/WASM parity proof and large A/B Edit arena suite
passed. The complete `npm run check` also passed: 647 unit tests, all 180
Chromium cases, native terminal and saved-machine proofs, configurable-drive
lifetimes (including sixteen-drive Edit), and Rust formatting, lint and tests.
The terminal copy change was then checked in a rebuilt browser at both desktop
and mobile sizes. The initial full-check attempts stopped because the shell
did not select the complete pinned Rust installation; the successful run used
Rust 1.98.0 and wasm-bindgen 0.2.127.

These are host and browser proofs. They do not establish physical ESP32
terminal latency or hardware timing.
