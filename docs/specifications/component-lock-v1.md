# Triptych component lock v1

## Purpose

The component lock selects the Z80 software inputs for one Triptych
distribution. It complements `Cargo.lock` and `package-lock.json`: those files
select Rust and JavaScript dependencies, while this file selects independently
released guest software and the ATOM toolchain used to build it.

The lock is build input. It contains no output digests and no commands supplied
by a remote repository. A successful distribution build writes a separate
artifact manifest containing the resolved Triptych revision and the digest of
every output.

The schema identifier is `triptych-component-lock-v1`.

## Top-level fields

| Field           | Meaning                                                                           |
| --------------- | --------------------------------------------------------------------------------- |
| `schema`        | Exact schema identifier.                                                          |
| `targetProfile` | Machine profile selected by the distribution, such as `triptych-cpu-v0.1`.        |
| `disk`          | Image size, 128-byte record size and count of reserved system records.            |
| `atom`          | Immutable ATOM repository revision, package identity and bootstrap-seed identity. |
| `components`    | Non-empty ordered list of resident and application components.                    |

All objects are closed: an unknown field is an error. Text identifiers use
lower-case letters, digits and hyphens. A target-profile identifier may also
contain dots. Byte counts, addresses and record numbers are non-negative safe
integers. Hashes use lower-case hexadecimal.

`disk.recordBytes` is 128 for the current machine profile. The image size must
contain complete records, and the system area must lie inside the image.

## ATOM identity

`atom` contains:

| Field         | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `repository`  | HTTPS repository URL.                                                    |
| `revision`    | Complete 40- or 64-digit Git object ID. A branch or tag is insufficient. |
| `package`     | `atom-z80`.                                                              |
| `seed.bytes`  | Exact bootstrap-seed byte length.                                        |
| `seed.sha256` | SHA-256 of those seed bytes.                                             |

The revision selects the assembler source and package. The seed fields identify
the binary root used by ATOM's reproducible self-hosting process. Both belong in
the release evidence.

## Components

Each component has these fields:

| Field     | Meaning                                                          |
| --------- | ---------------------------------------------------------------- |
| `id`      | Unique stable component identifier.                              |
| `role`    | `resident` or `application`.                                     |
| `source`  | One of the source forms below.                                   |
| `recipe`  | A trusted recipe name implemented by Triptych tooling.           |
| `target`  | Z80 load origin and maximum capacity.                            |
| `install` | System-record range or CP/M filename.                            |
| `licence` | SPDX expression or project `LicenseRef`, plus a provenance path. |

The list order is deterministic build order. Component identifiers, disk
filenames and resident ranges must be unique. Resident memory ranges must not
overlap. Application target ranges may overlap because CP/M loads one transient
program at a time.

### Source forms

A Git source has `kind`, `repository`, `revision` and `path`. The repository is
an HTTPS URL, the revision is a complete Git object ID, and the source path is
relative to that checkout.

A Triptych source has `kind: "triptych"` and a repository-relative `path`.
This form covers the Triptych BIOS and bootstrap. The lock does not contain a
self-reference: the output manifest records the Triptych revision that supplied
these files.

A retained prebuilt input has `kind`, `path`, `bytes`, `sha256` and
`provenance`. Its recipe must be `verified-prebuilt`. This form preserves a
reviewed historical fixture without inventing a source revision. It does not
qualify that fixture as an independently reproducible component.

Paths are normalized, relative and use forward slashes. Empty segments, `.` and
`..` are invalid.

### Trusted recipes

Recipe names select code already present in the Triptych release builder. The
builder rejects names outside its local registry. A lock therefore cannot add
a shell command, lifecycle script or executable path. A source-built component
cannot use `verified-prebuilt`, and a prebuilt component cannot select a build
recipe.

### Targets and installation

`target.origin` and `target.capacity` describe a half-open region in the Z80
address space. Capacity is positive, and the region must end at or before
`$10000`.

A resident component uses:

```json
{ "kind": "system-records", "firstRecord": 0, "recordCount": 16 }
```

Its record range must fit inside `disk.systemRecords`, must not overlap another
resident component, and must contain exactly `target.capacity` bytes. These
checks bind disk placement to the fixed resident slot rather than relying on
padding by convention.

An application uses:

```json
{ "kind": "file", "name": "EDIT.COM", "padByte": 26 }
```

The name follows the CP/M 8.3 character and length limits used by the Triptych
image builder. `padByte` is a byte; text-oriented applications normally use the
CP/M text EOF byte `$1A`.

## Validation and release status

`tools/lib/component-lock.mjs` validates this structure and the cross-field
rules. Structural validation is only the first release gate. The distribution
builder must also fetch each immutable source, reject dirty overrides in release
mode, run the registered recipe, check the emitted size and install a fresh
image without changing a user's working disk.

No production component lock exists yet. The portable OS and Edit need verified
standalone revisions before Triptych can create one without false provenance.
Until then, this specification and its executable validation tests define the
input boundary but do not claim a reproducible distribution.
