# Skate 0.5.1 for Triptych

Skate is a small Scheme compiler that runs on the Z80 under CP/M and produces
native executable programs. The disk library package contains the compiler,
its runtime provider, EDIT and three examples with source and compiled programs.

Open [Skate](https://jhlagado.github.io/triptych/?disk=skate) to boot directly,
without an installation or setup confirmation. Its
protected A disk supplies the reference copy. The personal B disk starts with
all ten files, ready for editing and compilation. Type `B:` and then
`TYPE README.TXT`. Run `RECEIPT`, `ROUTE` or `ACCOUNT` immediately, or edit a
source with `EDIT RECEIPT.SK8` and compile it with `SKATE RECEIPT.SK8`.

The examples demonstrate an itemised shop bill, a path search through an
adventure map and independent account balances implemented with closures.
They are noninteractive programs; keyboard input is still pending.

The compiler contains 12,726 bytes and its runtime provider contains 5,337
bytes. CP/M stores these as 12,800-byte and 5,376-byte files respectively.
Generated programs include their runtime. The compiler remains 3,658 bytes
below the 16 KiB code limit; workspace is counted separately.

The current language includes signed integers, closures, lexical bindings,
shared variable mutation, proper tail calls, lists, quoted data and output.
It remains incomplete: comparisons, input, floating point and further binding
and control forms are still to come. See the
[Skate release notes](https://github.com/jhlagado/Skate/blob/main/release/v0.5.1/README.md)
for the exact supported procedures, limits, size forecast and release changes.

The disk uses Triptych's retained four-drive 2 MiB CP/M profile. A is protected,
B is writable and C/D are empty. Existing starter and game configurations are
unchanged. Personal edits belong to this browser and origin; download a backup
before clearing site data or moving to another device. Reopening the same
configuration reuses its personal disk rather than replacing it with the seed.

Qualification covers compilation and execution of all three examples on B,
unchanged protected A bytes and execution after exporting and remounting B.
Physical ESP32 operation is not established by these emulator checks.
