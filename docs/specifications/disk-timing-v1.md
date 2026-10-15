# Floppy disk timing model

## Purpose

Triptych's disk controller completes every command at once. Software that
reads overlays, searches directories or streams files can therefore look fast
on Triptych and be slow on a real CP/M machine with mechanical floppy drives.
The timing model shows what the same disk activity would cost on a chosen
floppy drive, without changing the disk image format or the guest protocol.

The model is optional and off by default. It lives in `triptych-cpu-core`
(`Machine::configure_disk_timing`) and is exposed by the native host.

## Time base

All modelled time is measured in guest T-states and converted from the
profile's mechanical figures using the configured clock (4 MHz by default).
Host speed never affects the result, so the same run produces the same report
on any machine.

## Geometry

The profile, not the disk image's DPB, defines the floppy layout. The
controller's flat record number maps onto it as follows:

1. Record `r` lies in physical sector `r × 128 / sector_bytes`.
2. Physical sectors fill one track, then the next head, then the next cylinder.
3. Within a track, logical sector `l` occupies rotational slot
   `((l mod n) × skew + l div n) mod sectors_per_track`, where
   `n = sectors_per_track / gcd(sectors_per_track, skew)`. This is the usual
   CP/M skew table: skew 6 on 26 sectors reproduces the CP/M 2.2 8-inch table.

Skew applies to every track, including the system tracks. Images larger than
the profiled medium continue onto imaginary cylinders. The report notes when
the highest cylinder touched exceeds the real medium.

## Mechanics

Each physical sector transfer costs, in order:

- **ready**: head load or motor spin-up, when the drive is used for the first
  time or has been idle longer than the profile's idle time;
- **seek**: `step × cylinders moved + settle`, when the cylinder changes;
- **rotation**: the wait until the sector's slot reaches the head. Each drive's
  index hole passes at guest time zero;
- **transfer**: one slot's share of a revolution.

Each drive (A to P) keeps its own head position and idle timer. Changing heads
on the same cylinder is free.

## Deblocking

With 128-byte physical sectors, every record read or write is one physical
transfer and nothing is buffered, as in an unblocked CP/M 2.2 BIOS.

With larger sectors, the model behaves like a deblocking BIOS with one host
buffer shared by all drives:

- A read from the buffered sector is free and counts as a buffer hit.
- A read or write elsewhere first writes back the buffer if dirty, then reads
  the new sector. Writes always pre-read; the model does not apply the BDOS
  unallocated-block optimisation.
- A write marks the buffer dirty. The physical write happens when the buffer
  moves or on `FLUSH`.

This buffer is separate from the controller's real 512-byte cache. It only
accounts for time and never affects data.

## Modes

**Account.** Commands still complete at once and the controller never reports
busy. The model keeps its own clock that moves ahead by every wait the guest
skipped, so rotational positions are what they would have been had the guest
waited. The guest's behaviour and output are unchanged.

**Stall.** The controller sets status bit 0 (busy), and withholds data request,
until the command's modelled duration has elapsed in guest T-states. The
shipped BIOS polls busy, so it really waits. Software that ignores busy still
gets its data at once; the report then counts the unfinished wait in modelled
time.

Stall mode only changes guest time. To feel it in wall-clock time, pace the
CPU as well (`--realtime` on the native host).

Resetting the machine or changing media clears the model's buffer but keeps
head positions and counters. Reconfiguring timing restarts the counters.

## Built-in profiles

| Name       | Medium                              | rpm |  Sectors | Heads | Cyl | Skew | Step | Settle |  Ready |  Idle |
| ---------- | ----------------------------------- | --: | -------: | ----: | --: | ---: | ---: | -----: | -----: | ----: |
| `8in-sssd` | IBM 3740 8" SSSD, 250 KB            | 360 | 26 × 128 |     1 |  77 |    6 | 8 ms |   8 ms |  35 ms | 2.5 s |
| `5in-dsdd` | 5.25" DSDD, 400 KB, deblocking BIOS | 300 | 10 × 512 |     2 |  40 |    2 | 6 ms |  15 ms | 500 ms |   2 s |
| `3in-dsdd` | 3.5" DSDD, 720 KB, deblocking BIOS  | 300 |  9 × 512 |     2 |  80 |    1 | 3 ms |  15 ms | 500 ms |   2 s |

"Ready" is head load for the 8-inch drive and motor spin-up for the others.
The figures are typical of period drives, not of any one model.

## Native host

```sh
triptych-host-native --disk-timing 8in-sssd [--disk-timing-mode account|stall] \
  [--disk-skew N] [--clock-hz HZ] [--realtime] BOOT-ROM DRIVE-IMAGE ...
```

- `--disk-timing` selects a profile and enables the model.
- `--disk-timing-mode` defaults to `account`.
- `--disk-skew` overrides the profile's skew, for testing interleave choices.
- `--clock-hz` sets the guest clock used for conversion and pacing.
- `--realtime` paces execution to the guest clock in 10 ms slices. It works
  with or without disk timing.

When timing is enabled, the host writes a report to standard error on exit.
For example, booting the 2 MiB system disk in stall mode and running `DIR`
gives:

```text
disk timing: 8in-sssd at 4.000 MHz, stall (guest waited on BUSY)
  geometry:       360 rpm, 26 x 128 bytes per track, 1 head(s), 77 cylinders, skew 6
  modelled time:  12.38 s (0.50 s CPU incl. idle, 11.88 s disk = 96.0%)
  record I/O:     310 reads (0 from buffer), 0 writes
  sector I/O:     310 reads, 0 writes
  head load/spin: 1 x, 35.0 ms
  seeks:          13 (24 cylinders stepped), 296.0 ms
  rotation:       9557.9 ms waiting for sectors
  transfer:       1987.2 ms
```

"CPU incl. idle" includes time the guest spent polling the console. The report
is written on normal exit, guest halt, `--stop-after` and step-limit errors,
but not when the process is killed. Use scripted input
(`--input-ascii`, `--input-after`, `--stop-after`) to measure a specific
workload.

## Browser

The toolbar's **Disk** menu offers Instant (the default) and the three built-in
floppies. Choosing a floppy enables stall mode and paces the guest at 4 MHz, so
the delays are felt. A floppy is only slow relative to the CPU, and an
unpaced browser CPU would hide them. A status line under the save status shows
the time spent waiting on disk and the sector and seek counts. Its tooltip
breaks the time down into head load, seeking, rotation and transfer.

The choice is a per-browser preference in local storage, not part of a saved
machine, and it applies to every machine the page opens. Changing it restarts
the counters. Browsers throttle animation frames in background tabs, so pacing
allows up to half a second of catch-up and then continues at 4 MHz rather than
racing through a backlog.

The WASM boundary exposes `configure_disk_timing(profile, stall, clock_hz)`,
`disk_timing_report()` and `elapsed_tstates()` on `TriptychCpu`.

## Node package

`@jhlagado/triptych-headless` (in `packages/triptych-headless`) accepts
`diskTiming: { profile, mode, clockHz }` in `bootMachine`. It also offers
`setDiskTiming()`, which restarts the counters to measure a single command, and
`diskTimingReport()`, which returns the counters as a plain object with times
in milliseconds. Account mode is the default there, so tests keep running at
full speed.

## Limits

The model does not cover:

- track buffering BIOSes that read a whole track per revolution;
- multi-sector controller commands;
- the BDOS write-without-pre-read optimisation for unallocated blocks;
- per-track skew offsets;
- soft errors, retries or recalibration;
- overlap between seeking on one drive and transferring on another.
