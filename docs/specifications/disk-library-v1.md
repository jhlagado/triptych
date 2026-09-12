# Disk library and live media changes

Status: selected implementation contract, 12 September 2026. Public release
qualification is pending. This extends the
[disk-library roadmap](../plans/disk-library-and-launch-links.md); it does not
change the meaning of existing version-four saved-machine archives.

## Disk-box authority

The browser maintains one versioned disk-box authority containing personal
disks, machine configurations, launch instances and the selected configuration.
Personal disks have stable local UUIDs, display names, geometry and versioned
content references. A disk retains its identity and contents when ejected or
moved to another slot. Equal contents or names never merge disk identities.

A configured slot is empty, a published-image reference, or a personal-disk
reference with an access policy. Published references contain immutable
catalogue identity, geometry, size and content hash. Read-only images do not
acquire personal image blobs, guest-flush checkpoints or writable revisions.
A disposable network cache is permitted separately. Sector writes to protected
media fail even when guest software bypasses BDOS.

All personal disks, including ejected disks, remain roots for content retention.
Saved configurations and recovery backups also retain their referenced bytes.
An active-machine archive and a complete disk-box backup are distinct exports;
the former cannot represent every ejected disk. Deleting an unmounted disk is
an explicit user operation, not a side effect of garbage collection.

The storage implementation adds `disk-box-state-v1` and `disk-box-blobs-v1`
at IndexedDB version five, preserving all historical stores and rows. The
state store contains an explicit activation marker, head, backups and operation
receipts. One exclusive writer and a whole-library revision comparison protect
publication. Immutable content blobs and operation receipts support retries
after interrupted responses. Existing version-one through version-four records
remain readable through the new client's shared recovery reader.
Adoption preserves personal identities already present and never converts a
private disk to a published reference merely because its bytes match.

Only the writer may initiate the database upgrade. A non-owner opens an existing
database without requesting an upgrade and uses read-only transactions. An old
writer must save and release ownership first. The version-five upgrade closes
cooperative historical connections and prevents their version-four or earlier
openers from publishing obsolete heads. A connection that will not close blocks
the upgrade; it must not produce two writable authorities.

An upgrade creates the new stores but does not activate the library. Adoption
validates the latest historical state through the new connection, prepares
identities and hashes, then atomically copies active personal content and
publishes the new head and marker after rechecking that historical state.
Quota failure leaves the new library unactivated and historical rows intact.
The new client must expose historical recovery even in this upgraded but
unactivated state. An older client cannot reopen a version-five database;
recovery downloads therefore require the retained version-five recovery client,
not a database downgrade.

After activation, invalid new state requires recovery and never falls back to
an older writable head. New garbage collection examines only new blobs; this
release neither rewrites nor collects historical rows. Recovery includes raw
historical heads, content, backups and record exports independently of successful
runtime admission or new-manifest validation.

## Launch instances

A curated recipe has an immutable revision and digest, a matched machine
profile, protected image references and named recipient-local writable roles.
The first successful activation creates the requested role disks and records
their bindings atomically with the configuration. A persistent lookup from
recipe digest to the selected local instance determines subsequent launches.
Reloading uses those bindings without reseeding or creating duplicate disks.

Creating a fresh instance is explicit and atomically updates that recipe's
selected-instance lookup. A changed recipe revision requires preview and
activation; it does not rewrite existing work. Share links contain public
recipe information, never private UUIDs. Local bookmarks may contain local
identities, with missing disks reported for selection or explicit creation.

The initial default has four configured slots; the supported profile family
continues through sixteen. Existing saved machines retain their configuration
until the user explicitly changes it. Curated recipes are the first URL path;
external image URLs require a separate bounded-download and validation path.

## Prepared live media change

Host readiness and guest filesystem consistency are separate conditions.
The initial guest proof uses an ATOM-assembled program that closes its FCBs,
flushes writes and waits at an explicit disk-change prompt. After insertion,
the program resets the affected drive through BDOS function 37 and reopens
its files. Passing this proof does not qualify arbitrary programs with open
files or unfinished directory updates.

For a live change, the host follows this order:

1. Validate and allocate incoming backing before durable publication. Stop
   execution and input, require no partial controller transfer, dirty cache,
   unflushed backing writes or pending terminal input, and issue a prepared
   ticket. Hold that freeze until commit or cancellation.
2. Persist the outgoing acknowledged contents and intended new slot binding
   in one revision-checked transaction. A failed transaction leaves the old
   backing installed. An uncertain response requires receipt-based recovery.
3. Commit the matching ticket by invalidating the clean controller cache and
   replacing the prepared backing without allocation or CPU reset. Reject a
   stale ticket without releasing the freeze. Resume only after runtime and
   durable configuration agree.

While a ticket is pending, execution, input, reset, RAM mutation and other
backing changes are prohibited. This makes the prepared state stable across
the asynchronous database transaction. If an unexpected failure follows a
durable commit, execution remains stopped and recovery loads the committed
configuration; the obsolete medium must not resume.

The controller's cache currently identifies data by drive and sector. Changing
the backing therefore requires cache invalidation even when the old cache is
clean and the new disk has the same geometry. Controller preparation preserves
CPU registers, RAM, boot-overlay state and disk selection. It does not flush
guest application memory or update BDOS login state.

## System disk and warm boot

Cold boot uses A. The current BIOS also reloads resident system records from A
on warm boot, and geometry alone does not establish system-image compatibility.
Initial media tests can constrain A to compatible system disks. The complete
release must additionally support an explicit restore-system-disk path before
warm boot after a data disk has occupied A. It must neither boot arbitrary
data as resident code nor silently replace or rewrite the mounted disk.

BIOS changes remain Triptych machine code. Any portable BDOS changes belong in
Portable CP/M and enter Triptych through identified releases. No new guest I/O
port is required for the first cooperative swap fixture.

## Required evidence

Tests cover dirty and partial-transfer rejection, stale tickets, cancellation,
protected sector writes, same-sector cache replacement and unchanged CPU/RAM.
The guest fixture must continue after a swap without reboot and demonstrate
new directory/allocation state. Storage tests cover quota failures, stale tabs,
lost responses, ejected-disk retention and exact legacy recovery.

Hosted acceptance includes fresh and returning launch instances, no writable
records for protected-only use, writable-role reuse, game saves, live swaps,
system-disk recovery and complete downloadable backups. Local tests establish
host behavior only; ESP32 measurements and automatic disk jukebox operation
remain outside this release.
