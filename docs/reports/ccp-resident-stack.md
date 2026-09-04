# CCP resident stack checkpoint

Date: 2026-09-05

The Triptych CCP retains its fixed `$E400`–`$EBFF` resident slot. It places
a 16-byte `$A5` sentinel immediately below a 48-byte downward-growing private
stack. The 2,048-byte assembled image has SHA-256
`d5f90f3c7cac8ad902ab4224e9f09ba344a8d30bee63dc7622d7fd1db65b2476`.

| Region                       | Address range   | Bytes |
| ---------------------------- | --------------- | ----: |
| Code, data and command state | `$E400`–`$EB2C` | 1,837 |
| Shared command/load scratch  | `$EB2D`–`$EBAC` |   128 |
| Stack overflow guard         | `$EBAD`–`$EBBC` |    16 |
| Private resident stack       | `$EBBD`–`$EBEC` |    48 |
| Unused resident capacity     | `$EBED`–`$EBFF` |    19 |

`npm run check:ccp-stack` assembles the resident components with ATOM, boots
the Rust/WASM machine and advances it one instruction at a time. Four
fresh-boot cases cover successful built-ins, rejected and malformed commands,
successful file mutations, confirmed wildcard erase, a transient program warm
return and a valid command after the failures. Every case checks the entire
guard and records the lowest stack pointer reached.

The deepest observed use was ten bytes in each case after adding shared
filename validation. This proves the tested paths remain within the 48-byte
stack and leave the adjacent guard intact. It is a host-model result, not an
ESP32 measurement or a proof over every possible guest execution path.
