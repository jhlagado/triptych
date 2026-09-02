# Atom CCP built-ins checkpoint

Date: 2026-09-03

The Triptych CCP now implements the complete CP/M 2.2 resident command set:
`DIR`, `ERA`, `REN`, `SAVE`, `TYPE`, and `USER`. The implementation remains
inside the fixed `$E400..$EBFF` slot and reaches disk services only through
BDOS.

## Public behavior proved

Paired oracle and Triptych scenarios now cover successful and failed rename,
single-file erase, confirmed and cancelled `ERA *.*`, one-page save, replacement
of an existing saved file, valid user changes, invalid user and save operands,
and directory visibility across user 0 and user 1. The successful mutation
scenario compares the saved file byte-for-byte: `PAGE.COM` is 256 zero bytes
with SHA-256
`5341e6b2646979a70e57653007a1f310169421ec9bdd9f1a5648f75ade005af1`.

The loader boundary tests generate files from declarative bytes rather than
guest implementation source. A 58,112-byte COM file occupies the complete TPA
and returns through warm boot. A 58,240-byte file is rejected, after which
`DIR` still executes. This probe found and fixed an earlier limit comparison
against `$EC00`; the correct overwrite boundary is the CCP base at `$E400`.

Selecting absent drive B produces the same 30-byte transcript under the frozen
and Triptych CCPs, including exactly one line break before
`Bdos Err On B: Select`. With the current one-drive BIOS this BDOS error is
fatal until reset, so the scenario stops at the diagnostic rather than claiming
command recovery.

## Resident account

AZM emits a 2,048-byte image with SHA-256
`0e6100dd4c825f626d70262943b8e5698143dca1dd1d045f3825aaa5e79e486d`.

| Region                               | Range          | Bytes |
| ------------------------------------ | -------------- | ----: |
| Code and immutable data              | `$E400..$E982` | 1,411 |
| FCBs, input, state, and load scratch | `$E983..$EADC` |   346 |
| Private stack                        | `$EADD..$EB0C` |    48 |
| Unused resident capacity             | `$EB0D..$EBFF` |   243 |

The 48-byte stack allocation is unchanged. A worst-case stack trace and
sentinel proof still remain before the resident-account matrix row can move
from partial to proved.

## Remaining qualification

The new CCP launches `EDIT.COM`, assembles and runs `HELLO.COM` through
`ATOM.COM`, compiles and runs `INPUT.NU` through `NUC.COM`, and assembles its
own exact binary inside CP/M. The native two-process `SMOKE.COM` persistence
proof and the WASM headless suite both pass. Native and browser image
preparation now installs the Triptych CCP by default; an explicit `oracle`
selection remains available for development comparisons.

Media failure cases, generated parser boundaries, and the worst-case stack
proof remain before the matrix can record publication readiness. ESP32-S3
measurements remain deferred until hardware is available.

## Published browser proof

GitHub Pages workflow run
[`33655151446`](https://github.com/jhlagado/triptych/actions/runs/33655151446)
completed successfully for commit `ccdc020`. The deployed browser is available
at <https://jhlagado.github.io/triptych/>.

An HTTP fetch after deployment returned status 200. The served `config.json`
records `systemCcp` as `triptych`; the served `ccp.bin` and the first 2,048
bytes of the served `cpm22.img` both have SHA-256
`0e6100dd4c825f626d70262943b8e5698143dca1dd1d045f3825aaa5e79e486d`.
