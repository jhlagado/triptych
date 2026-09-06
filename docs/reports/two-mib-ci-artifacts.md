# Two-MiB resident-profile CI artifact audit

Date: 2026-09-07. This is development artifact evidence, not a published
component release or a replacement for Triptych's existing component pins.

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
