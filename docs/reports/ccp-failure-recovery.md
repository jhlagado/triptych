# CCP and BDOS failure-recovery checkpoint

Date: 2026-09-05

`npm run check:ccp-failures` assembles CCP, BDOS and BIOS with ATOM and runs six
fresh Rust/WASM machines against deliberately constrained media:

| Case                 | Required outcome                                                               |
| -------------------- | ------------------------------------------------------------------------------ |
| Read-only `SAVE`     | `Bad Sector`, acknowledge, warm boot, unchanged disk, valid `DIR`              |
| Read-only `REN`      | `Bad Sector`, acknowledge, warm boot, unchanged disk, valid `DIR`              |
| Read-only `ERA`      | `Bad Sector`, acknowledge, warm boot, unchanged disk, valid `DIR`              |
| Full directory       | `NO SPACE`, unchanged disk, valid `DIR`                                        |
| Full data area       | `NO SPACE`, documented empty `NEW.COM`, unrelated files unchanged, valid `DIR` |
| Truncated media read | `Bad Sector`, acknowledge, warm boot, unchanged disk, valid `DIR`              |

The failing-before read-only case repeatedly printed `Bad Sector` because BDOS
returned to the interrupted operation after the acknowledgement. On permanently
write-protected media it could never reach another command. Physical sector-I/O
errors now consume one acknowledgement and transfer through the BIOS warm-boot
entry. The direct-call tests separately inject both BIOS read and BIOS write
failures, pin the diagnostic and require that same transfer without publishing
the failed sector.

The full-disk result deliberately does not claim transactionality. `SAVE`
deletes an existing destination, creates a new directory entry and then writes
records. When no allocation block remains, the newly created empty file remains
visible. The proof pins that result while verifying that `README.TXT` and the
allocation-filling file retain their exact contents. A future transactional
replacement would be a separately specified behavior change.

The final 3,584-byte BDOS image has SHA-256
`c5fc4d7dd29bf8914c4735165747e3b35dca3b8999a9f70035d972ff602718fc`.
These are host-model proofs. ESP32 SD-card write protection, removal, latency and
power-loss behavior remain unqualified.
