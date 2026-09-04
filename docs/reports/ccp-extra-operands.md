# CCP extra-operand correction

Date: 2026-09-05

The headless WASM scenario
`test/ccp/scenarios/triptych-extra-operands.json` failed against the preceding
CCP. Both `DIR README.TXT EXTRA` and `TYPE README.TXT EXTRA` silently executed
with `README.TXT` and ignored `EXTRA`. This contradicted the CCP contract's rule
that extra operands are rejected before an operation begins.

`CMDDIR` and `CMDTYPE` now retain the first operand as the diagnostic token and
check for end of input after `PARSEFCB` and whitespace. The corrected scenario
reports `README.TXT?` for both commands. The same scenario also supplies extra
operands to `ERA`, `REN`, `SAVE` and `USER`, exercising the checks those handlers
already had. It then executes `DIR README.TXT` at the next prompt. The disk
remains byte-for-byte unchanged with SHA-256
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

GitHub Pages workflow run
[`33909978220`](https://github.com/jhlagado/triptych/actions/runs/33909978220)
passed for commit `901e15a`. A later fetch from
<https://jhlagado.github.io/triptych/> returned the Triptych system profile;
both `ccp.bin` and the CCP slot at the start of `cpm22.img` had the assembled
SHA-256 above.
