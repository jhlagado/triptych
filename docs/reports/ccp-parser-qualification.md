# CCP parser qualification checkpoint

Date: 2026-09-05

`npm run check:ccp-parser` assembles the Triptych resident software with ATOM
and runs 135 fresh-machine cases through the Rust/WASM host. The corpus has 71
named boundaries and 64 deterministic generated lines from seed `0x54524950`.
It covers:

- empty, space-only, lowercase and repeated-space input;
- the 8.3 field limits and the 127-byte console-line limit;
- legal and illegal drive prefixes;
- missing and extra operands for all six built-ins;
- `SAVE` decimal limits and overflow;
- `USER` decimal limits;
- wildcard acceptance for `DIR` and rejection for commands requiring one
  exact file;
- the CP/M 2.2 reserved filename characters; and
- generated visible-ASCII combinations of fields, delimiters and punctuation.

Every case must return to a stable prompt without changing the disk, preserve
the resident stack guard, and then successfully execute `DIR README.TXT`. Known
acceptance and rejection boundaries also pin identifying transcript fragments,
so a parser that merely rejects everything cannot pass.

The first failing regression was `REN =README.TXT`: the empty destination was
accepted and changed the directory. After rejecting that form, the adjacent
`REN .TXT=README.TXT` case demonstrated the same class of defect for an empty
primary name. The correction now applies one shared unambiguous-file check to
`TYPE`, both sides of `REN`, `SAVE`, and transient loading before any mutating
BDOS call. A shared field check rejects the remaining reserved characters.

The final 2,048-byte CCP image has SHA-256
`d5f90f3c7cac8ad902ab4224e9f09ba344a8d30bee63dc7622d7fd1db65b2476`.
This is deterministic host-model evidence. It does not cover physical terminal
transport faults or claim compatibility beyond the grammar in the CCP
contract.
