# Triptych CPU conformance format v1

Status: active test contract

Date: 2026-08-31

## Purpose

This format carries deterministic Triptych CPU cases between the TypeScript
reference model, the portable Rust core, native and WebAssembly hosts, and the
ESP32-S3 firmware. It is a test boundary, not a guest-visible device.

The [CPU v0.1 machine profile](cpu-v0.1.md) remains authoritative. A fixture
may prove a specified behaviour but cannot add a reset value, port, timing
source, storage rule, or peripheral to that profile.

## Files and encoding

Each fixture is one UTF-8 JSON file. Version 1 uses only JSON objects, arrays,
strings, booleans, and non-negative integers. Byte values are integers from 0
through 255. Addresses and port numbers are integers from 0 through 65535.
Hexadecimal notation may appear in descriptions, but JSON data remains numeric
so every host parses the same value.

The root fields are:

| Field         | Meaning                                                      |
| ------------- | ------------------------------------------------------------ |
| `format`      | exactly `triptych.cpu.conformance.fixture.v1`                |
| `id`          | stable lowercase identifier matching `[a-z0-9-]+`            |
| `description` | human explanation, excluded from execution and digest        |
| `initial`     | boot ROM, RAM, drives, serial input, and pre-reset CPU state |
| `run`         | finite safety budgets                                        |
| `observe`     | CPU fields and underlying-RAM ranges to retain               |
| `expected`    | complete expected result and its canonical digest            |

## Initial byte images

Boot ROM, RAM, and drives use this shape:

```json
{
  "size": 256,
  "fill": 0,
  "patches": [{ "address": 0, "bytes": [0, 1, 2] }]
}
```

The runner allocates exactly `size` bytes, fills them, then applies patches in
array order. Every patch must fit completely; overlap is legal and the later
patch wins. Version 1 requires a 256-byte boot ROM and 65,536-byte RAM. Drive
images must have a size divisible by 512 bytes. Reset occurs after RAM and
drive initialization and before serial input is enqueued.

`initial.cpu` is an object containing zero or more names from `observe.cpu` and
values to install immediately before reset. It exists to dirty defined state so
a reset fixture distinguishes a real reset from an already-clean provider.
Reset observations still constrain only values fixed by the machine profile or
subsequently established by the fixture program.

## Execution

`run.maxSteps` and `run.maxTStates` must both be positive. A step is one call
to the provider's instruction-step operation; it is a safety account rather
than a guest timing source. T-states returned by completed instructions are
the timing authority.

Execution stops after the first of:

- `halt`: the Z80 enters HALT;
- `step-limit`: `maxSteps` completed without HALT; or
- `tstate-limit`: accumulated T-states reached or exceeded `maxTStates`
  without HALT.

The final completed instruction is always included. A provider must not report
a partial instruction. Version 1 fixtures do not use a block-repeat instruction
when comparing step counts because development runtimes may expose a complete
block operation as one debugging step.

`run.interrupts` may schedule one interrupt after a completed step. An entry
contains a one-based `afterStep`, `kind` (`maskable` or `nmi`), and an eight-bit
data-bus value. No two entries may use the same step. The interrupt is presented
after that instruction's architectural effects and before the next fetch. Its
T-states are included exactly once in the accumulated total.

## Observations

`observe.cpu` lists only CPU fields whose values the fixture is entitled to
constrain. This prevents a test from accidentally freezing architecturally
unspecified reset state. Version 1 field names are:

```text
a b c d e h l
a_prime b_prime c_prime d_prime e_prime h_prime l_prime
ix iy i r sp pc imode iff1 iff2 halted
f.s f.z f.y f.h f.x f.p f.n f.c
f_prime.s f_prime.z f_prime.y f_prime.h
f_prime.x f_prime.p f_prime.n f_prime.c
```

CPU fields in a result are sorted lexicographically. Numeric fields remain
integers. `halted` remains a JSON boolean.

`observe.ram` contains half-open underlying-RAM ranges as `address` and
`length`. Ranges must fit in 64 KiB and are sorted by address in the result.
They bypass the boot overlay deliberately. The result also contains SHA-256 of
the complete underlying 64 KiB RAM, which distinguishes an unexpected write
outside the retained ranges.

The result contains an ordered SHA-256 digest for every persistent drive image.
This observes only bytes published by the logical-record controller: a dirty
cache line which has not been flushed cannot alter the drive digest. The drive
index is its position in `initial.drives`.

I/O observations record every completed operation in issue order. Each entry
has `direction` (`read` or `write`), the complete 16-bit Z80 port address, and
the transferred byte. The complete port proves CPU address formation while the
machine still decodes its documented low eight bits.

## Result

A complete result contains:

```json
{
  "format": "triptych.cpu.conformance.result.v1",
  "fixture": "fixture-id",
  "stop": "halt",
  "steps": 1,
  "tStates": 4,
  "cpu": { "halted": true, "pc": 1 },
  "bootRomEnabled": true,
  "ramSha256": "64 lowercase hexadecimal characters",
  "ram": [{ "address": 0, "bytes": [0] }],
  "driveSha256": [],
  "serialOutput": [],
  "io": []
}
```

Hosts compare the complete result before comparing its digest. A digest is a
compact ESP32 report, not a substitute for a useful failing diff on native
hosts.

## Canonical transcript and digest

The canonical transcript is ASCII with LF line endings and a final LF. Fields
appear in this exact order:

```text
triptych-cpu-result-v1
fixture=<id>
stop=<halt|step-limit|tstate-limit>
steps=<decimal>
tstates=<decimal>
boot-rom-enabled=<0|1>
cpu.<field>=<decimal-or-0|1>
ram-sha256=<lowercase hex>
ram.<four-digit-lowercase-address>=<lowercase-byte-hex>
drives=<decimal-count>
drive.<zero-based-decimal-index>-sha256=<lowercase-hex>
serial=<lowercase-byte-hex-or-empty>
io.<zero-based-decimal-index>=<r|w>,<four-digit-port-hex>,<two-digit-byte-hex>
```

There is one `cpu` line for each requested field in lexical order, one `ram`
line for each observed range in ascending-address order, one `drive` line for
each installed drive in index order, and one `io` line per operation in issue
order. Byte sequences have no separators. Empty serial output is `serial=`.
The digest is lowercase SHA-256 of the transcript's UTF-8 bytes.

Changing field order, number spelling, line endings, or the trailing LF changes
the digest. Adding a result field requires a new result-format version.

## Proof discipline

- A fixture needs finite step and T-state budgets even when HALT is expected.
- Expected state must distinguish a plausible wrong implementation, not merely
  reach a pass byte.
- Reset fixtures constrain only CPU values fixed by the machine profile or
  explicitly established by the program.
- Memory writes are checked both at their intended address and through the
  complete RAM hash.
- Port order and the full port address are retained.
- Debug80 Runtime is permitted only in the TypeScript test adapter. Fixture
  data and the production implementations do not depend on it.
- ESP32 results are labelled hardware evidence only after the fixture actually
  runs on the physical board.
