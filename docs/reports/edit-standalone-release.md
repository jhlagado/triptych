# Standalone Edit release checkpoint

Date: 2026-09-05

Edit is now independently hosted at
[`jhlagado/edit`](https://github.com/jhlagado/edit). Release `v0.1.0` points to
source revision `ac59b478b686b7cd1a3a340064e82d64fdc58589` and publishes:

| Artifact   | Bytes | SHA-256                                                            |
| ---------- | ----: | ------------------------------------------------------------------ |
| `EDIT.COM` | 3,003 | `bbe4ac2b6236d178089fcd01822d0d7fa3c6159f0d2da3655eba1212dda5aa02` |

The filtered repository retains 37 Edit-related commits and the original
implementation sequence. Its `npm run check` gate uses ATOM revision
`802b5c2d320bec777f427755ff2d7338e3b80a05`, rejects executable AZM
dependencies, reproduces the retained binary exactly and passes the isolated
Z80/BDOS/terminal proof. The first GitHub Linux CI run passed.

Triptych now vendors the published binary and manifest under
`third_party/edit/`. The provenance file pins the source revision and digest.
Fresh native and WASM release-image construction verifies and installs this
artifact through the CP/M image interface. A distribution test also proves
that the historical base disk contains the same program bytes and only `$1A`
record padding, so the provenance migration does not change the running guest.

The
[persistent Edit–Nucleus checkpoint](edit-nucleus-persistent-workflow.md)
now proves search/replace, save, NUC compilation, execution, fresh-machine
reopen and rerun through Triptych's current CCP/BDOS. This is host-model and CI
evidence, not ESP32 or physical-hardware qualification. Remaining S3 work is
now complete: Debug80 revision `6e1aa910` consumes the same pinned release,
retains its CP/M integration acceptance, and removes the duplicate editor
implementation, candidates and source-owned proof commands.
