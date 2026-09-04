# CCP SAVE decimal-overflow correction

Date: 2026-09-05

The headless WASM scenario
`test/ccp/scenarios/triptych-save-overflow.json` reproduced the suspected
decimal parser failure before the implementation changed. `SAVE 1280
OVERFLOW.COM` wrapped its page count to zero, returned without a diagnostic and
created an empty `OVERFLOW.COM`. The following `DIR` made the unintended disk
mutation observable.

The decimal accumulator multiplies its prior byte value by ten before adding
the next digit. When that value was 128, the first doubling set carry, but later
doublings cleared it before the existing overflow check. `CMDSAVE` now checks
carry immediately after that first doubling. This rejects a value that cannot
survive the multiplication while retaining valid final counts from 128 through 227.

After the correction, the same scenario produces `1280?`, confirms that
`OVERFLOW.COM` is absent, runs a valid `DIR README.TXT`, and finishes with the
disk byte-for-byte unchanged. Its final disk SHA-256 is
`cb640c716f7cb69c9f112c6067cc8ca3ec4e3676de2335cec4358364acca5c51`.
The complete headless scenario corpus also passes under the guarded ATOM-only
build.

The correction adds three bytes to code and immutable data. The 2,048-byte CCP
slot, 346-byte state area and 48-byte private stack are unchanged.

| Region                               | Range          | Bytes |
| ------------------------------------ | -------------- | ----: |
| Code and immutable data              | `$E400..$E985` | 1,414 |
| FCBs, input, state, and load scratch | `$E986..$EADF` |   346 |
| Private stack                        | `$EAE0..$EB0F` |    48 |
| Unused resident capacity             | `$EB10..$EBFF` |   240 |

The assembled CCP SHA-256 is
`94ca6d2f216035c8b2d5b7ecabc5e7308573f3fc3a2b6234f8597b6d5a566752`.
This is a host-model proof, not an ESP32 measurement. Parser fuzzing, media
failure coverage and the worst-case stack sentinel remain open qualification
work.
