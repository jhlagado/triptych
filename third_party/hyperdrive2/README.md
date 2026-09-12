# Hyperdrive II release input

Hyperdrive II is John Hardy's 1983 Microbee adventure, based on an idea by Ken
Stone. It is distinct from Ken's earlier VIC-20 Hyperdrive, which Triptych
installs as `HYPERDRV.COM`.

`HYPERD2.COM` and its manifest were verified against the [successful upstream CI artifact](https://github.com/jhlagado/hyperdrive2/actions/runs/34696562428/artifacts/10299251083). The native Z80 CP/M edition was assembled by ATOM from revision
`33c10ed036184a23892596d8b8cfe18162ad2f93` of the
[upstream repository](https://github.com/jhlagado/hyperdrive2/tree/33c10ed036184a23892596d8b8cfe18162ad2f93).
The executable is 13,543 bytes with SHA-256
`98133cf273534bed3966a0ed40f76e8efc3932efe954c83234fc86dd2add403d`.
The repository retains the recovered Microbee MWB BASIC source, historical copy
protection, conversion audit, native assembly and executable tests.

Type `HYPERD2` at the CP/M prompt. The game includes its story and help in the
COM. SAVE and LOAD write to the current CP/M drive; use a writable work disk
when the published games disk is protected.
