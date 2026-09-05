# Browser disk and deployment recovery

Release status: the version-2 recovery build is still being qualified locally.
The archive and redeployment instructions below become usable once the
integration report records the released tag, archive and verified identity.

Browser storage is not a substitute for an external backup. Download important
working disks and keep them outside the browser profile before upgrading tools,
adapting an operating system or trying another deployment.

## Restore a working disk

Save and exit the guest program, open **Files and recovery**, acknowledge that
the program has exited, and enter disk management. Select a saved backup or
stage a downloaded disk. Leave system adaptation unchecked for exact recovery.
**Apply and restart** preserves the displaced disk as another backup.

If the guest cannot boot or reach the ordinary management boundary, expand
recovery and use **Recover from saved disk**. Applying a replacement discards
unsaved guest RAM. This entry reads the durable browser copy; it does not save
an unsafe live guest cache over it. Cancellation resumes the previous machine.

Do not clear site data, delete IndexedDB or downgrade its version to recover a
disk. Those actions can destroy the saved work and its backups. A downloaded
disk can also be inspected in a separate browser profile or the native host.

## Retained website files

The [integration report](reports/browser-workspace-integration.md) tracks
qualification and will identify the released archive and full source revision.
Each recovery archive
contains `site/` with the exact served files and `recovery-archive.json` outside
that directory. The manifest records every asset's length and SHA-256 digest.
The external receipt records the manifest digest and intended storage schema.
It proves byte identity, not runtime compatibility by itself; the release also
needs the separate migrated-profile browser acceptance result.

Download the release archive, compare its SHA-256 with the recorded release
evidence, and extract it into a new empty directory. From a Triptych checkout
at the recorded source revision, verify it with:

```sh
node tools/archive-browser-recovery.mjs verify /absolute/path/to/extracted/archive FULL_SOURCE_REVISION
```

Use the full revision recorded with the release, not a guessed branch name.
Never use `--allow-development` to qualify a production recovery build. A local
preview has a different origin and cannot open the production site's storage.

## Redeploy a compatible release

For a supported source redeployment, use the retained release tag from the
integration report:

```sh
gh workflow run wasm-pages.yml --repo jhlagado/triptych --ref RETAINED_RELEASE_TAG
```

Watch that run on GitHub. It must pass the complete checks, final browser tests
and archive-retention step before Pages deployment. This rebuilds the tagged
source; it does not upload the retained archive byte-for-byte. Download that
run's recovery artifact and verify the new hosted deployment against it:

```sh
node tools/prove-hosted-browser.mjs https://jhlagado.github.io/triptych/ /absolute/path/to/downloaded/site FULL_SOURCE_REVISION
```

An exact-archive restoration instead needs a Pages workflow that uploads the
verified retained `site/` without rebuilding. That operator path is not
automated here. Do not substitute the old version-1 website: it cannot open a
profile already migrated to version 2. Neither a source redeployment nor an
exact-archive upload restores a disk; the browser's stored disk remains separate.

Compatibility evidence covers the qualified version-1 migration and version-2
profile, not arbitrary future storage schemas. Qualify recovery again before
any later schema change. The release run tests retained files at the same origin
with a disposable migrated profile; it does not overwrite the live website to
simulate an outage.
