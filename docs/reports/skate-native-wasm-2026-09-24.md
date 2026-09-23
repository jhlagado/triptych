# Skate generated-effects qualification

Status: first native/WASM host qualification passed on 2026-09-24.

The Skate source fixture `examples/applications/provider-trace.sk8` at
revision `1e18a7ac606685c09991dff0d775960110df3651` is compiled by the Skate
CP/M proof using ATOM. The resulting `TRACE.COM` is retained as
`test/fixtures/skate-provider-trace.com` with SHA-256
`8755b74847de73a856ff8a196fc51a922955f601977f9c384efabd9e45d17593` and a
load address of `$0100`.

The generated program's host-service vectors are the patchable `SRTOUTV` at
`$22A4` and `SRTINV` at `$22A7`. Each target host installs the same small Z80
serial stubs (`OUT (0),A; RET` and `IN A,(0); RET`) at `$F000` and `$F003`,
then runs the program with `Q` queued as input. Both hosts must produce the
same `Q\r\n` output and halt without reaching the legacy CP/M BDOS vector.

Commands:

```sh
npm run build:wasm-host
node tools/prove-skate-generated-wasm.mjs
cargo test -p triptych-host-native --test skate_generated
```

This is a host qualification fixture, not a production dependency on Skate or
Debug80. The normal Triptych build remains self-contained. The retained image
contains Skate's CP/M default adapter; the native and WASM host proofs patch
the vectors before execution, which demonstrates the host-neutral service
boundary. ESP32 is deliberately not part of this acceptance result.
