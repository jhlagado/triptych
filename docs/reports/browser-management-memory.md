# Browser disk-management memory measurements

Date: 2026-09-07. This is a local desktop measurement, not an ESP32 memory budget
or a guarantee about browser high-water memory use.

Three fresh-process runs per configuration measured the maximum sampled renderer
RSS during entry to file management, a small file import and Apply/reboot:

| Configuration     |      Run 1 |      Run 2 |      Run 3 |     Median | Median absolute deviation |
| ----------------- | ---------: | ---------: | ---------: | ---------: | ------------------------: |
| n01, A inserted   | 252.77 MiB | 272.53 MiB | 260.05 MiB | 260.05 MiB |                  7.28 MiB |
| n16, A–P inserted | 656.44 MiB | 558.42 MiB | 584.81 MiB | 584.81 MiB |                 26.39 MiB |

These values are total resident memory for the observed renderer processes,
including their other allocations, rather than additional memory per disk. The
comparison uses two realistic machine configurations with different resident
profiles; it does not isolate a causal cost for adding one drive.

## Workload and measurement method

The input was the actual sixteen-media archive exported during the browser
activation tests. Each image is 2,097,152 bytes. The n01 fixture preserved A's
filesystem and medium identity and installed the identified n01 resident tuple
through the configuration helper. Both fixtures were restored through the
public browser interface in fresh Chromium processes.

The measured sequence was archive restore and reload, a one-second baseline,
entry to management, import of `MEMPROBE.TXT` on A or P, Apply/reboot, archive
download, reload and guest `TYPE`, followed by another one-second observation.
The table covers the three management phases. Raw data also records restore,
archive download and reload separately.

The sampler obtained renderer process IDs from the browser's CDP process list
and read their RSS with `ps` approximately every 100 ms. It retained per-PID
values and their sum. Explicit samples immediately before and after each action
covered short retained states; some import phases had only those two samples.
The longest observed interval within the management phases was about 105 ms.
Cross-phase samples were excluded from per-phase statistics but remain in the
raw logs. RSS can count shared pages more than once and is not unique physical
memory. Browser, GPU and utility processes are outside this metric.

Separate CDP JavaScript heap readings were requested every 250 ms. They are
retained as supporting data, not substituted for RSS or interpreted as the
complete WASM and storage-buffer footprint. No forced garbage collection was
used. The n16 baseline included memory reclamation after reload, so its median
is not a demonstrated steady-state baseline. Action durations exclude the
explicit boundary samples; phase durations include their overhead.

Before the workloads, a separate blank Chromium process allocated and touched a
192 MiB array. Median renderer RSS rose by 198.53 MiB. That calibration confirms
that this sampler responds to resident buffer allocations. It does not establish
that every short-lived allocation between samples will be observed.

The host was an eight-core Apple M2 with 8 GiB RAM, macOS Darwin 25.5.0,
Node 24.18.0 and headless Chromium 151.0.7922.34. Other development work was
running; this was not a quiet-machine timing benchmark. No optimization or
before/after performance improvement is claimed.

## Correctness and retained evidence

All six workloads reloaded successfully and read the imported sentinel through
the guest CCP. Downloaded archives preserved configured count, medium IDs,
names, bootstrap bytes, reserved system areas and every unrelated disk image.
The original archive and all 72 served asset hashes remained unchanged. The
lead and an independent reviewer recomputed statistics from the raw logs;
the reviewer also checked all six downloaded archives. There were no sampler
errors or missing PID rows in the accepted run.

The [report](data/browser-management-memory-2026-09-07/report.json),
[deployment manifest](data/browser-management-memory-2026-09-07/deployment-manifest.json),
request trace and seven raw `samples.jsonl` files are retained in
`data/browser-management-memory-2026-09-07/`. Original temporary paths in the
report identify the captured run; the correspondingly named subdirectories here
contain its raw samples. The JSON report and request trace have a final newline
added for repository storage; their parsed contents are unchanged. Raw sample
files are byte-identical copies.

The complete local outputs, including downloaded archives, remain at:

```text
/var/folders/z3/5d423z657d7fm572qd818jd00000gn/T/triptych-management-memory-FXMJeJ
```

The utility SHA-256 was
`895d9b64288a4eee22182827bde56e84073dc0f97d73705933f526345fa1f23f`;
the frozen deployment manifest SHA-256 was
`661a232923aba5683b3533d64f052f1b83af0a25d98bafd50450244fec48f5c4`.
This was the reviewed development package, not a newly published release.

The first pilot failed because the open Files modal blocked the archive button.
Its partial evidence remains in the sibling `triptych-management-memory-Kmm36M`
directory and is excluded from all comparisons. After correcting the utility's
modal sequence and adding boundary samples for brief actions, calibration and
all six workloads were rerun with one frozen measurement implementation.

## Repeatable command

The optional development utility requires an already-built browser package and
an exported v4 archive with all sixteen media inserted:

```sh
node tools/measure-browser-management-memory.mjs --archive /path/to/all-sixteen.tds
```

It starts a private local server and fresh browser processes, retains a new
evidence directory and closes its server and browsers afterward. It does not
rebuild the package, change product files, run the main Playwright suite or erase
earlier test results. Repeating it on another machine or release produces a new
measurement, not a substitute for this run's recorded inputs and environment.
