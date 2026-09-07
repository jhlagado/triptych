# Two-MiB tool lifetime qualification

Date: 2026-09-07. All 16 two-MiB resident tuples passed the original
source/output/text proof. Counts 1, 3 and 16 also passed all five tool-arena
suites. These 31 completed invocations produced 544 checkpoints and 356 COM
lifetimes, with exact native/WASM console and inserted-image parity at every
checkpoint. Both final n01/n03 queues exited zero; no failed or timed-out case
was restarted.

The proof source is frozen in `15794514bd489b23a4c2f0e0cc7a959afe66cf73`.
The executions used that five-file change over dirty base
`f2b9c601520c87660a3f4bdddfc4b700c979040c`, before the source commit was made.
They used retained Portable CP/M 0.1.4 two-MiB residents and the existing
ATOM, NUC 0.3.1 and Edit component pins. No application bytes, assembly source
or release pins changed.

## Coverage and invariants

| Cases                               | Runs | Checkpoints | COM lifetimes | Placement exercised                                            |
| ----------------------------------- | ---: | ----------: | ------------: | -------------------------------------------------------------- |
| Source/output/text, n01 through n16 |   16 |         304 |           224 | Every configured tuple and allocation boundary                 |
| Five arenas, n01                    |    5 |          80 |            44 | A is both boot and writable work media; odd allocation padding |
| Five arenas, n03                    |    5 |          80 |            44 | A/C inserted, B absent; odd allocation padding                 |
| Five arenas, n16                    |    5 |          80 |            44 | A/P inserted, B–O absent; lowest resident origins              |

The five arenas are `atom-symbols`, `atom-parts`, `atom-chain`, `nucleus` and
`edit`. Their admitted capacities, exact diagnostics, failed-publication checks
and generated-program cases remain those in the
[A/B tool capacity report](eight-mib-tool-arenas.md).

The instruction observer now derives CCP, BDOS, BIOS and stack locations from
the fresh builder's captured assembly symbols. Each launch requires the exact
CCP `STKTOP - 2` address, an incoming zero return word and exact loaded COM
bytes. Each return requires PC zero, restored SP and preservation of that
word, followed by exact CCP/BDOS reload. The observer rejects execution of
dead CCP during a tool lifetime.

Immutable checks cover BDOS code, BIOS code and DPB, the four pointer words in
every DPH, and unused BIOS table padding. BIOS working storage and each DPH's
first eight bytes remain writable. Byte 127 of every 128-byte allocation slot
has a guard; all bytes in the unused odd-count half-page have a separate
sentinel. All inserted disks retain their complete system areas. Non-work
media remain byte-for-byte unchanged. Fixture preservation and Edit's explicit
writable-file assertions remain active when A is the work drive.

The recursive Nucleus fixtures retained the same measured 84-byte hardware
stack use after the resident move:

| Profile              | Entry SP | Minimum SP | Return SP |
| -------------------- | -------- | ---------- | --------- |
| Historical 8 MiB A/B | EAEB     | EA97       | EAED      |
| Two-MiB n01          | ECEB     | EC97       | ECED      |
| Two-MiB n03          | EBEB     | EB97       | EBED      |
| Two-MiB n16          | E5EB     | E597       | E5ED      |

The assertion is `SP >= entrySp - 84`, with terminal activation depth,
trap/failure state and code/read-only preservation still checked. This is a
bound for these retained fixtures, not a general generated-program ABI
guarantee. The maximum observed BDOS stack use was 14 bytes.

## Retained evidence

The [evidence index](two-mib-tool-lifetimes.json) records all 31 result-file
SHA-256 values, local evidence directories, counts, timings and stack readings.
It also records the exact native binary, WASM binary/binding and installed tool
digests. Each underlying result references cumulative console files and complete
checkpoint images. A separate read-only audit rehashed the referenced console
files and 196 distinct checkpoint-image files across the new matrix and
historical compatibility run. Those temporary directories are local evidence,
not release assets or signatures.

The historical default Nucleus run passed another 32 checkpoints and 29
lifetimes after parameterization. The focused tests also pin the pre-change
default fixtures, step inputs, output boundaries and declared limits for all
five suites. Only the drive-selection report ID is normalized in that
comparison. Existing `check:cpm-large-arenas` remains the full historical
runtime gate.

## Repeatable gate and cost

With native and WASM hosts already built, the new command is:

```sh
node tools/prove-two-mib-lifetimes.mjs --allow-dirty
```

It runs the fixed 31-case matrix with at most two proof processes. Each child
uses its own evidence directory and inherited output. On failure, the scheduler
stops assigning work and waits for both active proofs to close before rejecting.
There are no retries, subset flags or host builds. Omitting `--allow-dirty`
requires the existing clean-tree policy.

The new scheduler and CLI have 15 passing focused tests:

```sh
node --test --test-concurrency=2 tools/lib/two-mib-lifetime-matrix.test.mjs
```

These cover fixed coverage, two-worker concurrency, failure draining, invalid
CLI options, historical fixture identity, A/P routing and the translated stack
floor's first rejected byte. Independent read-only review found no actionable
issues in the runner/adapter or the new scheduler/CLI.

The measured invocations predate the wrapper. A complete live invocation of
that wrapper remains an integration gate; the individual cases were not
repeated merely to exercise scheduling. Its final output includes elapsed
wall time for CI budgeting. The retained per-proof intervals from evidence
directory creation to result publication total 1,474 seconds, excluding initial
assembly and distribution construction. This sum is not two-worker elapsed
time. The longest individual chain intervals were 218–270 seconds, including
native replay; their WASM phases took 160–196 seconds. These local timings do
not predict Linux CI duration.

Instruction-level PC/SP results come from WASM. Native proof covers exact
console and complete inserted-disk images. Browser execution, broader compiler
semantics and physical ESP32 qualification remain separate gates.
