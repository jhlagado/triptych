# A/B tool capacity qualification

Date: 2026-09-07. This extends the locally qualified browser checkpoint
`729f0d4`. It tests released tools under the E300/EB00 A/B resident layout;
it does not change the tools, their release pins or the operating system.

## Repeatable proof

`tools/prove-large-ab-limits.mjs` now accepts five additional named suites.
Each uses the same instruction observer, resident-memory checks and native
replay as the original source/output/text proof. The original 19 checkpoints
and 14 COM lifetimes were replayed after this change: every console digest,
complete A/B image digest, lifetime record and BDOS stack measurement matched
the preceding proof.

The new suites passed independently:

| Suite          | Checkpoints | COM lifetimes | Main boundaries                                         |
| -------------- | ----------: | ------------: | ------------------------------------------------------- |
| `atom-symbols` |          10 |             7 | Symbol records, private scope and pending references    |
| `atom-parts`   |           5 |             2 | Maximum total source parts and first rejected part      |
| `atom-chain`   |           5 |             2 | Maximum dependency chain and include cycle              |
| `nucleus`      |          32 |            29 | Source-admitted data, transcript, recursion and failure |
| `edit`         |          28 |             4 | Search/replacement buffers, full text and save overlays |

That is 80 additional checkpoints and 44 observed COM lifetimes. Every
checkpoint compares the complete native and WASM A/B images and console bytes.
A remains byte-for-byte unchanged. Both reserved system areas remain unchanged.
Original B files remain unchanged except the two explicitly writable Edit
fixtures, whose complete expected records are checked at every step.

For each launched COM, the observer verifies the actual loaded bytes, incoming
zero return word, return PC zero, exact restored SP and subsequent CCP/BDOS
reload. It also checks BDOS/BIOS immutable regions, allocation-vector guards
and stack bounds. Native parity covers console and disk bytes; instruction-level
PC/SP measurements come from WASM, not native tracing or ESP32 hardware.

Run `npm run check:cpm-large-arenas` after building the native and WASM hosts.
The complete `npm run check` includes this command after those builds. Suite
modules provide fixtures and assertions; they do not own an alternative machine
or duplicate the lifetime/replay engine.

## ATOM

The pinned ATOM release accepts 1,536 global symbol records and rejects the
1,537th. It also accepts 1,535 globals plus one private label, rejects a second
private label, and correctly evicts the private scope when another global label
is admitted at capacity. The pending-reference case patches all 585 forward
words to their independently calculated address; reference 586 fails.

The source resolver admits 255 total parts, both as a root with 254 siblings
and as a 255-part dependency chain. Part 256 and a two-file cycle fail. The
tests compare complete output records, including zero padding, and exact
diagnostics. Failed builds preserve the preceding executable; no temporary
publication file remains.

The long chain executes 644,904,145 instructions through the observed output
boundary. Only that step receives a 750-million-instruction, five-minute
allowance; all instruction and memory checks remain enabled. The ordinary
150-million-instruction limit cannot admit this valid source graph. This is
not a resolver performance improvement or a claim about Node-hosted limits.

## Nucleus

The proof consumes NUC 0.3.1 at source revision
`b5276a85fd36600a10dbd65039f0af3afc033f0d`. Its public compiler admits 1,024
bytes per aggregate and per initialized-data/BSS segment. One initialized
segment plus one BSS segment therefore admits 2,048 writable bytes. The test
writes and reads the first and last byte of both segments, then checks their
actual RAM addresses and the unchanged byte immediately after the combined
area. The next byte is rejected without replacing an existing executable.

The read-only tests admit 1,024 bytes and reject an oversized object and a
following object that exceeds the segment. A 58/59-assignment source pair
distinguishes an earlier semantic-transcript admission limit. That transcript
has both a 512-byte storage bound and a 255-operation bound with the same
capacity diagnostic; this test does not identify which predicate fires.

These test shapes stop at earlier compiler limits. They do not exercise the
theoretical 3,251-byte writable allowance or generated-code end address 0x5800.
The tests qualify actual admitted programs and safe rejection; the transcript
case does not prove a maximum generated-code size across all source shapes.
They do not claim the larger reserved capacities are usable, nor enlarge the
compiler as part of this disk milestone.

Eight recursive activations preserve distinct local values. The next activation
traps with code 5 before executing its body. A separate propagated failure 7
unwinds successfully. These cases observe entry SP EAEB, minimum SP EA97 and
return SP EAED: 84 bytes of measured stack use for these fixtures, not a general
generated-program ABI guarantee. Terminal activation depth is zero; the exact
trap/failure state, code/read-only bytes and return path are checked.

## Edit

The proof consumes Edit source revision
`2427501773e8d158d556631b8a4ba1cb972fcb4a`. Search and replacement accept
64 bytes; byte 65 produces exactly one bell and leaves the admitted value
intact. Cancelling both prompts, saving and repeating the retained search
checks the editor's temporary DMA overlap through real interaction.

A replacement grows 47,103 logical text bytes to the full 47,104-byte buffer.
The next growth attempt reports `Full` without changing text, length, cursor,
viewport, desired column, flags, committed query or save state, including the
high visual-column bytes. Save, quit, reopen and resave preserve exact records.
Unsaved changes are never mistaken for persisted file data.

## Review and remaining work

Independent reviewers checked modules they did not implement and the shared
observer. Review strengthened the Edit rejection assertion to include both
high visual-column bytes, and corrected the Nucleus transcript explanation so
it does not attribute a shared diagnostic to an unobserved predicate.

The focused suites and complete local `npm run check` passed, including 459 code
tests, 90 browser cases, 34 headless scenarios, the new capacity suites, native
terminal/image workflows and Rust workspace checks. Linux CI for this new
checkpoint remains a release gate, followed by retained-deployment and
same-origin hosted recovery qualification. Broader language semantics and
physical ESP32 execution remain outside this host disk qualification.
