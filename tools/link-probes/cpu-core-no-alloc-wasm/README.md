# CPU core allocation link probe

This standalone `no_std` WebAssembly library executes one Z80 instruction
through the public Triptych core. The pinned Z80 dependency unconditionally
imports `alloc` for its unused disassembler, so Rust requires an allocator
symbol at link time. This probe supplies an allocator whose every operation
immediately traps. Calling the exported function successfully therefore proves
that the exercised CPU path performs no hidden runtime allocation.

It is a development proof, not a browser host and not an ESP32 measurement.
