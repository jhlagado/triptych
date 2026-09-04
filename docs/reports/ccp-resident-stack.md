# CCP resident stack checkpoint

Date: 2026-09-05

The Triptych CCP retains its fixed `$E400`–`$EBFF` resident slot. It now places
a 16-byte `$A5` sentinel immediately below a 48-byte downward-growing private
stack. The 2,048-byte assembled image has SHA-256
`361dc3a0f75cd175d255b3388f2729b158cdc7ab6169e3b0358499dc8b2d2447`.

| Region                       | Address range   | Bytes |
| ---------------------------- | --------------- | ----: |
| Code, data and command state | `$E400`–`$EAB8` | 1,721 |
| Shared command/load scratch  | `$EAB9`–`$EB38` |   128 |
| Stack overflow guard         | `$EB39`–`$EB48` |    16 |
| Private resident stack       | `$EB49`–`$EB78` |    48 |
| Unused resident capacity     | `$EB79`–`$EBFF` |   135 |

`npm run check:ccp-stack` assembles the resident components with ATOM, boots
the Rust/WASM machine and advances it one instruction at a time. Four
fresh-boot cases cover successful built-ins, rejected and malformed commands,
successful file mutations, confirmed wildcard erase, a transient program warm
return and a valid command after the failures. Every case checks the entire
guard and records the lowest stack pointer reached.

The deepest observed use was eight bytes in the built-ins and recovery case;
the other cases used six bytes. This proves the tested paths remain within the
48-byte stack and leave the adjacent guard intact. It is a host-model result,
not an ESP32 measurement or a proof over every possible guest execution path.
