# Two-MiB resident-profile CI artifact audit

Date: 2026-09-07. The first section records pre-release development evidence;
the final section records the subsequent published release audit. Neither
changes Triptych's existing component pins.

## Initial development artifact

[Portable CP/M PR 5](https://github.com/jhlagado/portable-cpm/pull/5) passed
[Linux CI run 34067116885](https://github.com/jhlagado/portable-cpm/actions/runs/34067116885).
The run produced artifact `portable-cpm-triptych-2m`, ID `9999369658`, containing
48 files: CCP, BDOS and a manifest for each of the sixteen two-MiB profiles.

The downloaded ZIP matched GitHub's artifact digest:

```text
sha256:a0233d44a415f674d6ff4e26ce9388fa4bce23a86545b906825831bb64bd2f70
```

The PR head was `cf95f0f0ae7508b9b9405ba318e34d7c90b84584`. CI checked out the
synthetic PR merge `ad6341997ea82fd81578d66e33be8d9c668575e7`; both have tree
`b988f530c2965c8e4ecededc901ccdc475b7b35c`. Thus the tested merge's file contents
match the prepared branch, but its commit identity is different.

The audit verified all file hashes, exact profile IDs and origins, source
hashes, generated origin preambles and the locked ATOM revision
`802b5c2d320bec777f427755ff2d7338e3b80a05` against the committed build contract.
The profile IDs cover `triptych-cpu-v0.1-2m-n01` through
`triptych-cpu-v0.1-2m-n16`. Paired counts share resident origins and binary
contents while their manifest profile identities remain distinct.

These manifests report package version `0.1.3`, which already has a public
release. They must not be presented as assets from that existing release or
used to overwrite it. At inspection, PR 5 remained open and this artifact had
an expiry of 2026-12-05. Permanent release qualification therefore still needs
an appropriate new version, release build and retained assets, followed by
download verification and explicit Triptych consumer pins.

## Published v0.1.4 verification

The version gap above was subsequently resolved by releasing
[Portable CP/M v0.1.4](https://github.com/jhlagado/portable-cpm/releases/tag/v0.1.4)
from merged commit `d28fc52774c967d1422b3b814d51c069247504c1`.
[Linux main CI run 34068547951](https://github.com/jhlagado/portable-cpm/actions/runs/34068547951)
passed the 402-test component gate. Its eighteen profile outputs matched the
fresh local production builds: sixteen two-MiB profiles, the default profile
and the retained eight-MiB A/B profile, each with CCP, BDOS and a manifest.

A separate reviewer downloaded all five public assets after publication and
compared them byte-for-byte with retained CI artifacts. The ZIP member sets were
exact, and all 54 files matched the local build and recorded hashes. Every
manifest declared version `0.1.4` and the correct named profile. The reviewer
also checked component hashes, tagged source hashes, reconstructed ATOM origin
preambles and the annotated tag's target. The lead independently repeated the
five complete published-file comparisons.

| Published asset                            | Bytes | SHA-256                                                            |
| ------------------------------------------ | ----: | ------------------------------------------------------------------ |
| `bdos.bin`                                 |  3584 | `52f481e90cf12c4610db1609f7d4247ff3b00eb31705fca06a52701a3723714e` |
| `ccp.bin`                                  |  2048 | `e74d61f096f6c9de01d77cd990a3255c4f0d46d771992a5e54b7993ed51fe18b` |
| `manifest.json`                            |  1282 | `3729d71f9b14772185f9bf2d1e3c0a3df9003340e7a5974d50a0b14fe899df66` |
| `portable-cpm-triptych-cpu-v0.1-2m.zip`    | 75121 | `30b96c91993db526331367543f3951959c14200ea03d55bccc40651faa015649` |
| `portable-cpm-triptych-cpu-v0.1-8m-ab.zip` |  4571 | `3a5442f1f0f9031d87f2dae1b95b63ce76f042557596c23c723b61299ce99fc0` |

Downloads remain under `/tmp/portable-cpm-v0.1.4-redownload.szTSBo`; the retained
54-file inventory is `/tmp/portable-cpm-v0.1.4-release.uHR2oh/verified.json`.
The tag is unsigned. Redownload verification establishes artifact identity,
not fresh guest execution, browser activation, new-layout application safety or
ESP32 behavior. Triptych consumer pins and complete host qualification remain
separate work. The existing v0.1.3 release was not overwritten.
