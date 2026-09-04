# CCP extra-operand correction

Date: 2026-09-05

The headless WASM scenario
`test/ccp/scenarios/triptych-extra-operands.json` failed against the preceding
CCP. Both `DIR README.TXT EXTRA` and `TYPE README.TXT EXTRA` silently executed
with `README.TXT` and ignored `EXTRA`. This contradicted the CCP contract's rule
that extra operands are rejected before an operation begins.

`CMDDIR` and `CMDTYPE` now retain the first operand as the diagnostic token and
check for end of input after `PARSEFCB` and whitespace. The corrected scenario
reports `README.TXT?` for both commands, then executes `DIR README.TXT` at the
next prompt. Its disk remains byte-for-byte unchanged with SHA-256
`06b907b1e03f615b190dc83ed97d9c7862c5d32e5f8967e3568ae48e171a96ae`.
The complete guarded headless scenario corpus passes after the change.

The two checks add 22 bytes to code and immutable data. The 2,048-byte CCP
slot, 346-byte state area and 48-byte private stack are unchanged.

| Region                               | Range          | Bytes |
| ------------------------------------ | -------------- | ----: |
| Code and immutable data              | `$E400..$E99B` | 1,436 |
| FCBs, input, state, and load scratch | `$E99C..$EAF5` |   346 |
| Private stack                        | `$EAF6..$EB25` |    48 |
| Unused resident capacity             | `$EB26..$EBFF` |   218 |

The assembled CCP SHA-256 is
`2bbe49b9be12186da02d439a407ddf40559da231bb4b828569ba4031def8f07f`.
This is a host-model proof, not an ESP32 measurement. Long-command generation,
filename and wildcard boundaries, media failures and the worst-case stack
sentinel remain open.
