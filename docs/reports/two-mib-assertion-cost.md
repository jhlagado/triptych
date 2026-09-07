# Disk-test assertion cost

Date: 2026-09-07. Scope: host test assertions, not disk implementation speed.

The combined verification run timed out in the existing blank-disk test while
comparing complete typed arrays through Vitest's generic `toEqual` matcher.
The test passed alone, but retained little margin below its five-second timeout.
Replacing only typed-array equality assertions with Node's `deepStrictEqual`
preserves complete byte, length and type comparisons. Geometry, alias checks,
fixtures, mutation checks and timeouts are unchanged. No product code changed.

## Measurement

Environment: macOS arm64, Node v24.18.0, current Triptych dependencies. The ruler
was three sequential executions per version of:

```sh
npx vitest run test/distribution/blank-disk.test.mjs --reporter=json --outputFile=/tmp/sample.json
```

Each invocation used a distinct report filename. Sample count was fixed at three
before measurement, with median and median absolute deviation (MAD) as the
summary. The acceptance rule was an improvement larger than observed sample
variation, with all assertions passing. These are wall-clock test durations,
not CPU profiles or a claim of controlled machine load.

Raw durations in milliseconds, as emitted by the JSON reporter:

| Version/sample | Geometry test | Independent storage test | Multi-extent test |     File duration |
| -------------- | ------------: | -----------------------: | ----------------: | ----------------: |
| Before 1       |   1586.185291 |              2844.112292 |       4626.337250 | 9058.337158203125 |
| Before 2       |   1643.544750 |              3439.157375 |       4189.855833 | 9273.855712890625 |
| Before 3       |   1866.621209 |              2692.502875 |       4452.006000 | 9013.006103515625 |
| After 1        |      9.457750 |                 2.512625 |          3.156875 |   15.156982421875 |
| After 2        |      8.951250 |                 2.557000 |          3.175833 |   15.175781250000 |
| After 3        |     10.776292 |                 3.033042 |          3.812583 |   17.812500000000 |

Every sample passed all three tests. Median file duration fell from
9058.337158 ms (MAD 45.331055 ms) to 15.175781 ms (MAD 0.018799 ms).
The changed assertion mechanism accounts for the measured comparison; these
figures do not establish a filesystem or emulator performance improvement.

Separate strict-assertion probes rejected a changed final byte of a 256,512-byte
array, a one-byte length difference, and an equal-length `Int8Array` in place of
`Uint8Array`. Thus the faster comparison still distinguishes the corruption and
representation failures relevant to these tests.

Original JSON reports are retained in
`/tmp/triptych-two-mib-host-smoke.Te931B/assert-baseline-{1,2,3}.json` and
`assert-final-{1,2,3}.json`. The table above retains the raw duration samples
independently of those temporary files. The complete repository verification is
a separate integration gate; focused timing results do not replace it.
