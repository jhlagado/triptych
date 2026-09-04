# CCP filename-boundary correction

Date: 2026-09-05

The headless WASM scenario
`test/ccp/scenarios/triptych-filename-boundaries.json` failed against the
preceding CCP. An overlong name was silently truncated, a four-byte extension
could open the corresponding three-byte-extension file, and an overlong SAVE
name created a file under its truncated name. A command word longer than eight
bytes was already rejected.

`PARSEFCB` now returns carry when a name or type exceeds its eight-byte or
three-byte field. It still consumes the rest of the malformed field so callers
retain the original token boundary, and `*` keeps its existing expansion and
skip behavior. Every command path checks the overflow result before calling
BDOS. Transient argument publication retains its established truncation
behavior because those arguments are passed to the program rather than acted
on by CCP.

After the correction, the scenario accepts an exact eight-byte filename,
rejects overlong DIR, TYPE and SAVE fields, rejects the overlong command,
executes a valid command at the next prompt and leaves the disk byte-for-byte
unchanged. Its disk SHA-256 is
`a6a0bd4f9d7e370eb0f78a2b6c592d518b962209197496b107b8eca7a17e051f`.
The complete guarded headless scenario corpus passes.

The checks add 57 bytes to code and immutable data compared with the preceding
extra-operand checkpoint. The 2,048-byte CCP slot, 346-byte state area and
48-byte private stack are unchanged.

| Region                               | Range          | Bytes |
| ------------------------------------ | -------------- | ----: |
| Code and immutable data              | `$E400..$E9D4` | 1,493 |
| FCBs, input, state, and load scratch | `$E9D5..$EB2E` |   346 |
| Private stack                        | `$EB2F..$EB5E` |    48 |
| Unused resident capacity             | `$EB5F..$EBFF` |   161 |

The assembled CCP SHA-256 is
`55aff78b1317e16c9be270822bf3d1f2f0be88bd836fe7ee2deca91bcae6fd80`.
This is a host-model proof, not an ESP32 measurement. Generated long-command
coverage, wildcard-form boundaries, media failures and the worst-case stack
sentinel remain open.
