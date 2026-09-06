# Browser disk and deployment recovery

These instructions cover version-three drive sets. Select a recovery build
from the [published releases](https://github.com/jhlagado/triptych/releases)
only when its notes identify version-three qualification, the exact retained
archive and its verification evidence. The
[browser A/B report](reports/eight-mib-browser-ab.md) records implementation
and pre-release acceptance. The earlier `wasm-0f7f077` qualification covered
version-two storage and is not a downgrade target for a version-three profile.

Browser storage is not a substitute for an external backup. Use **Download
saved drive set** and keep the `.tds` file outside the browser profile before
upgrading tools, adapting an operating system or trying another deployment.

## Save, checkpoint and complete-set downloads

A complete drive set contains the exact bootstrap bytes, resident-profile
label, A image and optional B image. **Download saved drive set** exports the
durable browser copy. **Download latest checkpoint set** exports each drive's
last successful guest flush, including data not yet persisted after a browser
storage failure. Neither download contains unsaved editor text or unflushed
writes. A newer successful flush on A can be included while B remains at an
older checkpoint; this is not a guest transaction across both drives.

Guest Ctrl-S and browser persistence are separate operations. Save and exit
the guest program, then wait for **Working disk saved in this browser.** before
reloading. After a storage failure, download the latest checkpoint set before
leaving, and use **Retry saving** if appropriate. **Reset machine** does not
create a backup.

**Download saved disk A** or **Download saved disk B** exports only the drive
selected in Files. Its **Download latest checkpoint** counterpart uses that
drive's guest-flushed bytes. Single images omit the bootstrap and resident
profile; retain a `.tds` archive when exact complete-set recovery is required.

## Restore a drive set

Save and exit the guest program, open **Files and recovery**, acknowledge that
the program has exited, and choose **Enter disk management**. Use **Stage
complete drive-set archive** for a downloaded `.tds`, or a backup row's **Stage
restore**. **Apply and restart** preserves the displaced complete set as
another backup before restarting with the restored set.

Restoration includes the exact bootstrap and both drive positions, including
an absent B. It does not adapt the operating system or merge files. A backup
row's **Download set** exports its complete set; **Download backup** exports
only the drive selected in Files. Test important archives in a separate browser
profile before depending on them.

For a single disk image, use **Stage disk image** on the intended drive. B
requires an eight-MiB image and the A/B resident profile. For A, choose the
matching **A image resident profile** explicitly:

- **Legacy E400, one drive** for a historical single-drive image.
- **Eight MiB E400, one drive** for the one-drive large-disk system.
- **Eight MiB E300, A/B** for the two-drive system.

**Keep the current bootstrap and profile** is appropriate only when they match
the replacement A image. Stage removal of B before selecting a one-drive
profile. Leave **Adapt external image with this release's CCP/BDOS/BIOS
(changes system bytes)** unchecked for exact disk-byte restoration. Capacity
does not establish resident-system identity. Unlike a `.tds` restore, this
manual path selects a bootstrap/profile separately from the image.

## A stuck guest or damaged saved state

If the guest cannot boot or reach the ordinary management boundary, expand
**Guest stuck or disk will not boot?**, accept the loss of unsaved state on
apply, and choose **Recover from saved disk**. This entry reads the durable
browser set; it does not save an unsafe live guest cache over it. Download the
latest checkpoint set first if it contains work you need. Applying a
replacement discards guest RAM and changes absent from browser storage.
**Cancel changes** resumes the previous machine.

If saved-state validation fails, startup stops rather than replacing the
stored data with a fresh disk. Preserve **Download raw saved manifest** and
every available **Download raw A**, **Download raw B** and **Download raw
bootstrap** file. These downloads retain the stored bytes even when hashes
are malformed or do not match; they are recovery evidence, not a validated
`.tds` archive. Missing payloads cannot be reconstructed from their hashes.
An unaffected backup may still be available independently through **Download
set**. For older stored records, retain **Download legacy recovery data** when
available.

Do not clear site data, delete IndexedDB or downgrade its version to recover
work. Those actions can destroy saved media and backups. The version-three
upgrade retains the older disk and backup stores. A failure to load WebAssembly
does not itself prevent saved-set or raw downloads; preserve those copies
before troubleshooting the guest or website.

## Retained website files

A website recovery archive is separate from a `.tds` drive-set archive. The
former contains application files; the latter contains your saved media and
bootstrap. Before a production recovery release can be used, its published
evidence must identify the retained archive, full source revision, release tag,
archive digest and successful version-three hosted recovery run. A green build
or a temporary CI artifact alone does not establish that qualification.

Each website recovery archive contains `site/` with the exact served files and
`recovery-archive.json` outside that directory. The deployment manifest records
each asset's length and SHA-256 digest. The external receipt records the
manifest digest and intended storage schema, currently `triptych-drive-set-v3`.
Archive creation records `runtimeQualification: not-performed`: matching bytes
alone do not prove compatibility with saved browser state.

Once a compatible release is qualified, download its archive, compare its
SHA-256 with the release evidence, and extract it into a new empty directory.
From a Triptych checkout at the recorded source revision, verify it with:

```sh
node tools/archive-browser-recovery.mjs verify /absolute/path/to/extracted/archive FULL_SOURCE_REVISION
```

Use the recorded full revision, not a guessed branch name. Older archives
require their corresponding release verifier; the current verifier requires
the current assets and profile descriptors. Never use `--allow-development`
to qualify a production recovery build. A local preview has a different origin
and cannot open the production site's storage.

## Redeploy a compatible release

This procedure requires a retained tag qualified for the saved schema. Do not
substitute an older version-one or version-two website for a version-three
profile. A source redeployment and an exact-archive upload are distinct
operations; neither restores the browser's saved media.

For source redeployment, inspect the `github-pages` environment rules first.
If deployment is restricted to `main`, an administrator must allow the exact
retained release tag. Preserve existing rules and avoid a wildcard. GitHub
documents the [deployment-policy API](https://docs.github.com/en/rest/deployments/branch-policies#create-a-deployment-branch-policy)
and its required administrator permissions. This command returns the new
temporary rule's ID:

```sh
gh api --method POST repos/jhlagado/triptych/environments/github-pages/deployment-branch-policies -f name=RETAINED_RELEASE_TAG -f type=tag
```

Dispatch the checked workflow at that tag:

```sh
gh workflow run wasm-pages.yml --repo jhlagado/triptych --ref RETAINED_RELEASE_TAG
```

Watch that run on GitHub. It must pass the complete checks, final browser tests
and archive-retention step before Pages deployment. This rebuilds the tagged
source; it does not upload the retained archive byte-for-byte. Download that
run's recovery artifact and use the release's qualified hosted verifier against
it:

```sh
node tools/prove-hosted-browser.mjs https://jhlagado.github.io/triptych/ /absolute/path/to/downloaded/site FULL_SOURCE_REVISION
```

Use the version-three verifier from the recorded release revision. An earlier
version-two result is not evidence for A/B or complete-set recovery. After
successful redeployment and hosted verification, remove only the temporary
rule created above, using its returned ID:

```sh
gh api --method DELETE repos/jhlagado/triptych/environments/github-pages/deployment-branch-policies/TEMPORARY_RULE_ID
```

Exact-archive restoration needs a Pages workflow that uploads the verified
retained `site/` without rebuilding. That operator path is not automated here.
Recovery qualification must run the retained files at the same origin with
disposable saved profiles, including A/B state and legacy migration, without
loading replacement assets from the current deployment. It need not overwrite
the live website to simulate an outage. Qualify recovery again before any
later storage-schema change.
