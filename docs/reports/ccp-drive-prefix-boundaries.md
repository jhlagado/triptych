# CCP drive-prefix boundary correction

Date: 2026-09-05

The native terminal probe `DIR Q:README.TXT` exposed a parser error in the
preceding CCP. `PARSEFCB` subtracted the drive-letter offset without first
checking its range. It therefore stored drive number 17 in the FCB. The current
BDOS subsequently treated that value as the default drive, so the command
silently listed `A:README.TXT` instead of rejecting the unsupported prefix.

The new headless WASM scenario
`test/ccp/scenarios/triptych-drive-prefix-boundaries.json` captured the
required result before the correction and failed with the current-drive
listing. `PARSEFCB` now accepts drive letters from `A` through `P` only and
returns its existing malformed-field signal for any prefix outside that
range. All command callers already reject that signal before a file operation.

After the correction, `DIR @:README.TXT` and `DIR Q:README.TXT` report their
respective malformed tokens, leave the disk byte-for-byte unchanged and accept
`DIR A:README.TXT` at the next prompt. The scenario's disk SHA-256 is
`93f48e46e2f2e3f24b9e2f97bcdf8d43b2d5f1b0985137ddbc7f945d9e504b69`.

This parser proof does not claim working multi-drive file access. A separate
probe confirmed that the current single-drive BDOS profile treats an otherwise
valid explicit FCB drive as the selected drive. Drive A remains the supported
baseline; multi-drive behavior needs its own BDOS contract and tests.

The range check adds ten bytes to code. State and stack capacity are unchanged.

| Region                               | Range          | Bytes |
| ------------------------------------ | -------------- | ----: |
| Code and immutable data              | `$E400..$E9DE` | 1,503 |
| FCBs, input, state, and load scratch | `$E9DF..$EB38` |   346 |
| Private stack                        | `$EB39..$EB68` |    48 |
| Unused resident capacity             | `$EB69..$EBFF` |   151 |

The assembled CCP SHA-256 is
`361dc3a0f75cd175d255b3388f2729b158cdc7ab6169e3b0358499dc8b2d2447`.
The targeted scenario, complete headless scenario corpus and guarded
`npm run check` pass. The latter includes 175 TypeScript tests, the CCP and
BDOS gates, the Rust workspace and the release WASM build with AZM imports
blocked.

GitHub Pages run
[`33915549518`](https://github.com/jhlagado/triptych/actions/runs/33915549518)
built and deployed Triptych revision
`e3d693acc7771a7fa77410d4dea2cab8d530d247`. A fresh download of the
published `ccp.bin` has the same SHA-256, and the deployed configuration selects
the Triptych CCP.

This is a native-terminal observation and host-model WASM proof, not an ESP32
measurement. Generated command-line coverage, media failures and the
worst-case stack sentinel remain open.
