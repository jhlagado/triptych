# Native saved-archive sessions

Date: 2026-09-07. Implementation is in a separate development branch;
local file and terminal checks passed. Integration and release qualification
remain pending; see the [verification report](../reports/native-saved-archive-sessions.md).

The first native launcher accepts the same `.tds` archive exported by the
browser. It extracts the saved bootstrap and inserted media into a new private
session directory, then starts the Rust host with the archive's configured
count and explicit drive letters. It retains the original archive unchanged.

```sh
node tools/run-saved-machine-native.mjs \
  --archive /path/to/machine.tds \
  --session /path/to/new-session \
  --deployment /path/to/retained/deployment-manifest.json
```

The default executable is `target/debug/triptych-host-native`; `--host` selects
an already-built executable. The launcher performs no assembly or system
adaptation. Two-MiB archives require metadata for their saved profile. Admission
checks descriptor consistency and the saved bootstrap hash; it does not
authenticate a release or verify every deployment file. Historical archives
require no metadata. An explicitly supplied metadata path must be readable and
valid JSON, even when the archive itself does not require admission metadata.

## Selected boundary

The archive already contains bootstrap identity, configured empty slots and
medium IDs. A new native JSON authority would duplicate that information and
require its own migration rules before the first useful launch. Raw image paths
alone cannot recover the same machine identity. The archive-first bridge reuses
the existing compatibility dispatcher and leaves all saved resident bytes intact.

Preparation opens a regular source without following a leaf symlink, captures
its bytes and rejects a changed source. V4 capture enforces the archive-size
limit before allocation and uses bounded reads; historical size compatibility
is unchanged. It validates the complete archive before
creating output. The destination must be a new directory; existing files,
directories and dangling links are rejected. Each inserted slot gets a separate
file named by drive letter, even when two disk payloads are identical. Saved
display names are never used as path components.

The session contains `original.tds`, `bootstrap.bin` and `drive-A.img` through
the last inserted drive. On preparation failure, partial files remain for
inspection and no launch plan is returned. On normal exit, host failure or
interruption, the directory remains. Terminal configuration must be restored on
every supported exit path.

## Checkpoint limitation

The native provider writes dirty cache evictions into its files before a guest
flush. Flush calls `sync_all`; it does not retain a separate acknowledged
checkpoint image. Consequently, session disk files are raw recovery data. The
launcher does not replace `original.tds` or automatically repack those files
as a new saved checkpoint after Ctrl-C.

A later persistent-session design needs an explicit native checkpoint boundary
before it can support verified archive round trips. That change is separate
from this copy-only launcher. Hardware power-loss behavior also requires its
own measurements.

## Verification sequence

1. Qualify file preparation at all sixteen counts with captured real bootstrap
   descriptors. Check sparse A/P, identical-content independent files, original
   archive preservation, source changes, exclusive destinations and partial
   write failures.
2. Exercise the public launcher on a Unix pseudo-terminal with a real browser
   archive and native host. Check P access, Ctrl-C and SIGTERM, exact retained
   bootstrap/media and complete terminal restoration. Controlled executables
   separately test normal exit, host error and failed spawn.
3. Integrate the new checks without removing the historical native launcher or
   its tests. `npm run check:native-saved-machine` generates fresh fixtures and
   tests the already-built native/WASM artifacts; it is required by the full
   repository gate. Run that complete gate and Linux CI. Publish instructions
   only with evidence distinguishing native execution from controlled fixtures.
4. Design acknowledged native checkpoint export before adding resumable session
   publication or claiming browser/native persistent round trips.
