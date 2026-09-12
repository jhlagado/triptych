# Disk library and launch links

Date: 2026-09-12

Status: library storage, protected mounts, live swaps and versioned launch UI
have focused local proofs. Full release qualification and public deployment
remain pending. The [release procedure](../disk-library-releases.md) covers
candidate builds and permanent retention of published images.

This restores the disk-manager proposal discussed in Caverns on 8 September,
approximately 23:15–23:45 Melbourne time, and incorporates the 12 September
decision to prioritise it. The original conversation distinguished published
images, personal disks and drive slots, with live disk swapping as its first
technical proof. This document is a development plan, not a claim that these
features are deployed or a frozen URL/storage specification.

## Intended experience

A visitor follows a shared Triptych link and boots a configured CP/M machine.
Published software disks are mounted read-only from complete sector images.
Only requested personal writable disks acquire writable browser-database
entries. A visitor can browse a curated library, insert and eject disks, copy
files to a personal disk, and return later with saved work intact.

The floppy-disk box supplies bulk storage outside the guest address space.
Four configured slots, A–D, are the initial default; retain the configurable
1–16 range rather than imposing a four-drive limit. Manual disk swaps are part
of this release. Hard-disk emulation, banked memory and automatic jukebox
operation are later work. ESP32 SD storage follows the WASM implementation.

## Disk identity and ownership

| Concept         | Meaning                                                                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published image | Identified, immutable sector image with format, size, hash, source, licence and tested compatibility. Read-only mounting creates no personal writable disk. |
| Personal disk   | Stable local identity, display name and writable contents persisted independently of the mounted slot. Ejection retains it in the disk box.                 |
| Drive slot      | Configured guest drive, empty or bound to one disk with an explicit access policy.                                                                          |
| Launch recipe   | Versioned selection of machine profile, published image identities and recipient-local writable-disk roles.                                                 |

Archive downloads may use a disposable network cache; this is separate from
personal writable storage. Read-only protection must be enforced on sector
writes, including direct controller access, not merely on the website controls
or CP/M file attributes. Making a writable copy is an explicit operation.
Identical blank disk contents do not imply identical personal disk identity.

## Shared links and local disk references

A representative recipe has a compatible published system image in A, a
personal work disk in B, published games in C, and a personal saves disk in D.
Short catalogue identifiers should resolve to versioned, hash-checked images.
The eventual URL may expose letter assignments, but its exact syntax remains
part of the first contract milestone; no example query here is a working link.

A public recipe describes writable roles such as work and saves, initially
blank or explicitly seeded from a published template. On first use, create
separate recipient-owned disks and record the role-to-disk bindings. Reloading
the same recipe reuses those bindings and preserves writes; it must not create
another set, reset the disks or reinstall their templates. Creating a fresh
independent instance is a separate action. Recipe revision and role identities
must be specified before implementing this behaviour.

A local bookmark can refer to existing personal disk identities. A sender's
disk number, display name or database ID cannot identify the recipient's disk.
Missing local references require selection or explicit creation; never bind an
unrelated disk by a coincidentally matching name. Shareable links omit private
disk identifiers. Sharing existing contents requires an explicit export or
published template, not access to another person's browser database.

Validate the whole requested configuration before publishing new bindings.
Opening a link must preserve any existing machine and personal disks. A trusted
curated recipe may initialise an empty visitor setup; a conflicting existing
setup requires a preview and explicit activation. External image URLs need
bounded downloads, supported schemes, browser cross-origin compatibility and
image validation. Arbitrary URL input must not trigger deletion, formatting,
private-disk export or silent writes to existing personal media.

## Geometry, memory and boot

Use the [two-MiB profile family](../specifications/cpm-two-mib-v1.md) for the new
default. The published A/B starter deployment and older saved machines remain
separate compatibility inputs; do not equate a development profile with the
currently hosted release or automatically convert saved images.

The current profile generator reserves 127 live allocation bytes plus one
guard per configured drive, rounded to a 256-byte page. Each drive also has a
16-byte DPH inside the fixed 1K BIOS reservation.

| Configured drives | Allocation reservation | DPH bytes inside BIOS | COM load ceiling in bytes |
| ----------------- | ---------------------- | --------------------- | ------------------------- |
| 2                 | 256                    | 32                    | 58,368                    |
| 4                 | 512                    | 64                    | 58,112                    |
| 8                 | 1,024                  | 128                   | 57,600                    |
| 16                | 2,048                  | 256                   | 56,576                    |

These are current layout calculations, not new hardware measurements. Four
slots retain 1,536 more COM-load bytes than sixteen. Ejecting media does not
change the configured profile or reclaim RAM. Profile changes require matched
resident artifacts and explicit reconfiguration; a COM load ceiling is not a
guarantee about every application's private buffers or stack.

The current bootstrap cold-boots from A and the BIOS reloads system records
from A on warm boot. Each bootable recipe must pair compatible A contents with
the exact bootstrap and resident profile. A data disk is not necessarily
bootable. Direct boot from B is outside the initial release. Swapping a data
disk into A while a program runs must include a defined system-disk recovery
path before warm boot; no silent replacement or rewriting of the user's disk.

## Execution stages

| Stage                       | Deliverable                                                                                                                                 | Acceptance evidence                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Contracts and swap proof | Reconcile the unmerged configurable-drive work with the public A/B release. Define image, personal-disk, recipe and media-change contracts. | ATOM guest fixture requests a second disk and continues without reboot; dirty-cache, partial-transfer, CP/M login/allocation state and warm-boot behaviour are tested. |
| 2. Protected library mounts | Published catalogue and read-only sector backing, with explicit writable-copy operation.                                                    | A library-only launch boots and runs with no personal writable-image records; guest writes fail and image hashes remain unchanged.                                     |
| 3. Personal disk box        | Create, name, import, export, mount and eject persistent writable disks.                                                                    | Writes survive ejection, reassignment and reload; alias mounting, stale tabs, quota errors and interrupted saves preserve prior durable data.                          |
| 4. Launch recipes           | Public links and separately identified local bookmarks; four-drive default with up to sixteen supported.                                    | A fresh browser launches protected A/C and writable B/D; revisiting reuses saved work; missing identities and malformed recipes leave existing machines intact.        |
| 5. Hosted qualification     | Catalogue assets, launch controls, recovery documentation and CI publication to GitHub Pages.                                               | The actual public URL passes fresh and returning desktop/mobile-browser workflows, write protection, live swaps and downloadable recovery tests.                       |

Stage 1 resolves the shared boundaries. Stages 2 and 3 can then proceed in
parallel, with disjoint implementation ownership. Stage 4 integrates both;
stage 5 qualifies the built release. Independent reviewers challenge storage
loss, URL authority and guest media-change behaviour before release. One
coordinator owns shared build outputs and publication.

The current [configurable-drive roadmap](two-mib-configurable-drives.md) uses
backup/reboot for media changes and explicitly excludes live hot swap. This
follow-on milestone must prove that extension; replacing an image array alone
is insufficient. Portable CP/M changes belong in its own repository, while
Triptych retains BIOS, host storage, image tooling and browser ownership.

Games that save to their current drive require a selectable writable target or
an explicit writable copy. Merely mounting a saves disk in B or D cannot
redirect application writes. Qualify the actual Caverns and Hyperdrive releases
against this rule before advertising their protected launch recipes.

## Current implementation and next task

The controller guard, prepared WASM media ticket and ATOM cooperative two-disk
fixture pass local tests, including a negative control without the BDOS drive
reset. The [foundation report](../reports/disk-library-foundation.md) separates
this evidence from the remaining release requirements. The selected
[library contract](../specifications/disk-library-v1.md) defines disk ownership,
publication order and adoption of historical storage.

The disk-box authority, raw recovery downloads, protected catalogue mounts,
A-system restoration and launch-instance reuse now have local tests. Browser
tests cover game saves, failed preparation, an image outside the starter recipes,
and an old shared link after a games-library update. The update test changes the
games image while retaining the same operating-system bytes.

The three local-configuration bookmark browser tests pass. Browser release
builds now reject empty pins and candidate refresh before compilation. Next,
qualify the complete check sequence, pin a clean library package and verify the
final release on GitHub Pages. Completion requires the public-site workflow;
local host proofs do not establish ESP32 hardware behaviour.
