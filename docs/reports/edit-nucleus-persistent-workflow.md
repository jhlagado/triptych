# Edit–Nucleus persistent workflow checkpoint

Date: 2026-09-05

Triptych now has a headless WASM contract for the complete guest development
loop in `test/bdos/scenarios/triptych-bdos-edit-nucleus-persistent.json`.
The scenario:

1. boots the Triptych CCP, BDOS and BIOS;
2. opens `INPUT.NU` in the independently released `EDIT.COM`;
3. finds the character literal `'O'`, replaces it with `'Y'`, and saves;
4. compiles the saved source with `NUC INPUT.NU`;
5. runs `INPUT.COM` and observes `YK`;
6. starts a fresh emulated machine on the exported disk;
7. types and reopens the saved source, then reruns the persisted program.

The final physical CP/M files are pinned by size and digest:

| File        |  Bytes | SHA-256                                                            |
| ----------- | -----: | ------------------------------------------------------------------ |
| `INPUT.NU`  |    128 | `2ce7df9e2c537759763bab2df7d9cf90f13b934be3c01393ffb3d1179b4a7f9f` |
| `INPUT.COM` | 25,600 | `ece4160d60bc9ad5be53f9cfe3e438b28c9f9fb2b0c482c20bcdb00998f0da88` |
| `EDIT.COM`  |  3,072 | `c39db09039ddb9287c5cbc4381875855e735255a8a0a4f3741dedf51d314848b` |

The proof found and fixed a CCP command-state defect. `PARSEFCB` cleared only
the first 16 bytes of its reusable FCB, leaving the sequential-record field
from `TYPE` behind. A following transient command therefore started loading at
record one and failed silently. The parser now clears all 36 FCB bytes, and the
fresh-session `TYPE` → `EDIT` sequence is part of the regression contract.

The headless runner also accepts an exact transcript SHA-256 plus byte length.
This keeps long ANSI repaint transcripts reviewable while still detecting any
byte-level change; short scenarios can continue to embed their exact transcript.

`npm run proof:cpm-headless` passes all 34 host-model scenarios after the
change. This proves the Rust/WASM model and CP/M disk round trip. It is not a
physical ESP32 measurement, browser interaction-automation result or claim of
universal CP/M compatibility.
