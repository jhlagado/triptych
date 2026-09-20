# COPY.COM v1

`COPY.COM` is a small CP/M transient that copies one file to one new file.
The command syntax is:

```text
COPY source destination
```

The source comes first. Each operand is an ordinary CP/M 8.3 filename, with an
optional drive letter from `A:` through `P:`. The command accepts one source
and one destination only; wildcards, concatenation, prompting, and directory
traversal are outside this version's contract.

COPY refuses to replace an existing destination. It opens the source, creates
the destination, selects its own 128-byte DMA buffer, and copies records through
the public CP/M BDOS FCB calls. A failed copy closes the open FCBs and removes
the partial destination where BDOS permits it. The transient reports usage,
missing source, existing destination, or a general disk error, then returns to
the CCP warm-boot entry path.

The implementation is ATOM source in `apps/copy/copy.asm`. Triptych assembles
it as part of the fresh distribution; the generated metadata records the ATOM
revision, source path, byte count, and SHA-256 digest.
