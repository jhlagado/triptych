# Disk library releases

The published library is retained in `distribution/disk-library/`. Its registry
names immutable images, launch recipes, bootstrap bytes, blank writable seeds
and the evidence needed to load each system version. Every normal browser build
includes that retained package. An ordinary host update does not change its
default recipes.

The initial empty registry permits development builds before the first library
release. Once a library has been pinned, adding or updating software requires an
explicit candidate build. This avoids a revision cycle in which committing the
retained files would itself generate another unpinned recipe.

A browser build with `--release` requires pinned starter and library defaults.
It rejects an empty registry or `--refresh-disk-library` before compilation or
output staging. Development candidate builds remain available with the refresh
flag; they are not publication builds.

## Preparing a candidate

Component releases and their provenance must already be committed in a clean
checkout. Run the complete checks before preparing the candidate. The refresh
flag then builds the current library and merges it with all retained versions:

```sh
npm run check
npm run build:wasm-browser -- --refresh-disk-library
node tools/prove-disk-library-registry.mjs
npx playwright test --config=playwright.config.mjs
```

The last two commands test the captured candidate without rebuilding it. Running
`npm run check` again here would rebuild the normal pinned library, so a fresh
candidate build and its tests would be required before pinning. These local
checks do not prove a public deployment. Acceptance also requires independent
review, CI and browser tests against the final public site.

Each application needs a tested write-protected workflow. The starter has tools
and the system on A, personal work on B, games on C and personal saves on D.
Running a game from C does not redirect its writes by itself: select D as the
current drive before launching the game, as exercised by the game tests. An
application that requires writes beside its executable needs an explicit
writable copy or a supported output-drive setting.

## Pinning and publishing

After candidate qualification, the pin command takes the exact source revision
recorded in the clean candidate deployment:

```sh
triptych_release_revision=$(git rev-parse HEAD)
node tools/pin-disk-library.mjs dist/wasm-browser "$triptych_release_revision" --advance-defaults
git diff -- distribution/disk-library
```

The command checks release evidence and validates every retained recipe with
the browser's validators before writing. It appends verified assets and replaces
the registry last. Existing versions remain present; defaults advance only with
`--advance-defaults`. A pre-existing `.disk-library-pin.lock` requires investigation
of an interrupted or concurrent operation. Do not remove it while a publisher
is running.

The pin command invokes the separate deployment checker with `--release` to
verify a clean candidate's source and asset evidence. That checker accepts
qualified candidates; the browser build guard prevents publishing an unpinned
candidate. The two uses of `--release` have different responsibilities.

Commit the reviewed retained-package changes, then build normally:

```sh
npm run build:wasm-browser -- --release
node tools/prove-disk-library-registry.mjs
```

The rebuilt registry must match the committed registry exactly. The host's
revision will have changed, but the pinned recipe revisions and assets must
remain unchanged. Full checks and CI qualify this final commit before deployment.

Public acceptance includes a fresh protected-only launch with no personal disk
blobs, a starter launch with independent writable disks, returning-user writes,
an older shared link, game saves, live media changes, system-disk restoration and
downloadable recovery data. Local tests do not establish ESP32 behaviour.

## Shared links and personal state

Public links contain a recipe identifier and immutable revision. They describe
writable roles, not another person's database identities. First activation
creates the recipient's disks; subsequent activation reuses that instance.
Creating a fresh instance is explicit. A new default never replaces existing
personal disk contents.

Device-local bookmarks use `configuration=` to reopen an existing configuration
in the same browser profile and website origin. They contain no exported disk
contents and cannot create that configuration on another device. Use the public
recipe link to share a setup, or a backup to transfer saved work.

Whole-machine archives and complete disk-box recovery downloads have different
contents. A machine archive contains its mounted media; a disk-box recovery
download also preserves ejected personal disks and historical records. Published
read-only images remain references in the disk box, with their bytes retained
in the published library.

The [roadmap](plans/disk-library-and-launch-links.md) and
[storage contract](specifications/disk-library-v1.md) define the remaining
release acceptance requirements.
