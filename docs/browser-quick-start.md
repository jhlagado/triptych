# Browser development session

This guide describes the current development checkout's disk box, published
library and retained small-disk and eight-MiB controls. It does not establish
that these changes have been deployed or passed the complete release gate. The
[published releases](https://github.com/jhlagado/triptych/releases) record
qualified revisions, hosted test results and recovery downloads for the
[Triptych website](https://jhlagado.github.io/triptych/). A development checkout
can contain changes that have not yet been deployed. The
[browser A/B report](reports/eight-mib-browser-ab.md) records implementation and
pre-release acceptance evidence.

In a desktop browser, wait for `A>` and click the terminal to type. A fresh
tools-and-games configuration has four two-MiB drives:

- **A: protected system and tools** — CP/M, ATOM, NUC, EDIT and source samples.
- **B: personal work** — an initially empty writable disk.
- **C: protected games** — `CAVERNS.COM`, `HYPERDRV.COM` and `README.TXT`.
- **D: personal saves** — an initially empty writable disk.

Published images are fetched by hash and are not copied into the personal
disk store. Use B for sources and build outputs, and D for the starter games'
saves. An
existing disk box reopens its selected configuration. Earlier browser storage
requires the explicit **Adopt my saved machine into the disk box** action;
adoption preserves its disks and resident system instead of installing this
starter arrangement.

## Configurations and links

**Disk box and published library** contains the saved configuration selector,
personal disks and published images. **Activate tools and games setup** reuses
the local disks associated with that recipe. **Create independent tools and
games setup** creates separate personal work and save disks. **Activate
protected library only** inserts A/C and leaves B/D empty. Each activation
retains the preceding configuration and personal disks.

The **Share tools and games setup** and **Share protected library only** links
contain a public recipe identity and revision. A recipient gets the specified
published disks and their own local writable roles, not your files or saves.
Use the generated link, including its revision, rather than constructing a
link to whichever setup is newest. Retained assets and publication procedures
are documented in [Disk library releases](disk-library-releases.md).

**Bookmark on this device only (not shareable)** uses a `configuration=` ID.
It selects an existing configuration in this browser profile and website
origin; it cannot recreate that configuration on another device. Keep a backup
when moving work or clearing browser data. Selecting a **Saved configuration**
and choosing **Activate saved configuration** is another way to reopen it.

The older `?machine=supplied` route remains a separate saved workspace. Its
label **Open the supplied A+B machine** is retained for compatibility; use it
to reopen earlier saves, not to request the new four-drive arrangement in your
usual workspace. The **Published starter disks and older A/B downloads** section
also contains the historical
[A: image](https://jhlagado.github.io/triptych/drive-a-system.img) and
[B: image](https://jhlagado.github.io/triptych/drive-b-games.img).
These eight-MiB starter downloads are not backups of your saved work.

## Play Hyperdrive

In the four-drive setup, type `D:`, then `C:HYPERDRV` at `D>`. The explicit
program drive loads Hyperdrive from protected C while the current drive D
receives saves. This is Ken Stone's original 1982 VIC-20 adventure, not John
Hardy's later Hyperdrive II.

Type `HELP` for the story and commands. Space or Enter advances long text;
Q skips its remaining pages. `INVENTORY` shows your equipment. Use `SAVE CAMP`
and `LOAD CAMP` to keep and restore a position. `QUIT`, then `Y`, returns
to CP/M. Wait for the browser's saved-disk status before closing the page.

For an older writable A/B setup with the game on B, enter `B:` then `HYPERDRV`;
its saves remain on B. To install a missing copy, select a writable disk in
Files, stage `HYPERDRV.COM` from the tool catalogue and apply the change. The
[Hyperdrive repository](https://github.com/jhlagado/hyperdrive) contains the
source and player documentation; development walkthroughs contain spoilers.

## Play Caverns

Protected C includes `CAVERNS.COM`, John Hardy's revised 1982–83
adventure. Enter `D:`, then `C:CAVERNS` at `D>` so saves go to D. The full story
and current rules appear at startup; `HELP` repeats them. Space or Enter advances
each page; Q or Escape
skips the remaining explanation. `INVENTORY`, `INVENT`, `I` and `LIST` show what
you carry.

Use `SAVE CAMP` to save a position and `LOAD CAMP` to return to it. `QUIT`, then
`N`, returns to CP/M. Wait for the browser's saved-disk status before closing or
reloading the page, and download a disk backup to keep a copy outside the browser.

In an older writable A/B setup, enter `B:` then `CAVERNS` to play and save on B.
If that disk lacks the game, use Files to install
`CAVERNS.COM` from the supplied application catalogue, then apply the change.
Back up your disk first. Installing the program does not require deleting your
saved games. The [upstream player guide](https://github.com/jhlagado/caverns80/blob/cpm-caverns/docs/player-guide.md)
is safe to read before playing; development audits and walkthrough tests contain
spoilers.

## Play Colossal Cave

In **Disk box and published library**, expand **Colossal Cave: start, save and
resume** and follow **Open the Colossal Cave setup preview**. The generated
link contains the exact published recipe revision. In an existing disk box,
choose **Activate requested setup** to activate it; opening the link alone
preserves your selected configuration. This four-drive setup has protected
system A, personal work B, protected Colossal Cave C and empty D. Returning to
the same setup reuses its personal B disk and saves.

To use your existing four-drive configuration instead, save and exit its guest
program, select C in the library, acknowledge that files are closed and flushed,
then choose **Insert** beside **Colossal Cave Adventure (350 points; four-drive
profile)**. Keep the matching system disk on A. In either arrangement, type
`C:` then `ADVENTUR`. Answer `NO` to skip the instructions. `ENTER`, `TAKE KEYS`
and `INVENTORY` exercise the first room; `QUIT`, then `YES`, returns to CP/M.

Colossal Cave uses a memory-image save, unlike Caverns and Hyperdrive. In the
game, enter `SAVE`, then `YES`. At the resulting `C>` prompt, immediately enter:

```text
SAVE 224 B:SAVED.COM
```

This writes the suspended game to your personal B disk. Reusing `SAVED.COM`
replaces that save; use another CP/M filename to keep an earlier position.
Before reloading or
closing the page, open **Files**, acknowledge that the guest
program has exited, and choose **Enter disk management**. Once **CPU paused.**
appears, close Files to resume; that management step checkpoints the writable
disks. Download B or a complete backup to keep the save outside this browser.

After a fresh boot, type `C:` then `B:SAVED` to resume. C must remain the
current drive because `PHROGZ.DIN`, the game database, is on C. The 224-page
save size is tested only for the four-drive `triptych-cpu-v0.1-2m-n04` profile.
The game's text mentions a 90-minute delay; the tested saved executable resumed
immediately.

For a writable C disk, select the inserted Colossal Cave disk, give its copy a
name, acknowledge closed/flushed files and choose **Make writable copy of
inserted disk**. Then use the new personal disk's **Insert** button to mount it
on C. After `SAVE` and `YES`, use `SAVE 224 SAVED.COM`; after a later boot, enter
`C:` then `SAVED`. The published image stays unchanged. Writing directly to
protected C produces `Bdos Err On C: Bad Sector` rather than a save file.
The [Colossal Cave guide](../samples/colossal-cave/README.md) records the binary
provenance, exact image hash and qualification limits.

## Assemble and run

The tools on A are protected, and B starts empty. To prepare B, open **Files
and recovery**, select A under **Drive to view or edit**, and download
`HELLO.ASM` and `INPUT.NU` from the file listing. Save and exit any guest program,
acknowledge this in Files, then choose **Enter disk management**. Select B,
use **Stage file imports** for those two downloads, and click **Stage update**
for `ATOM.COM`, `NUC.COM` and `EDIT.COM`. **Apply and restart**, then close Files.
This copies files into B without changing protected A.

On the prepared work disk, enter each command followed by Enter:

```text
B:
ATOM HELLO.ASM
HELLO
```

ATOM reports `HELLO.COM written`; the program prints `Hello from ATOM`.

## Edit, compile and reopen

With B selected in CP/M, this exercise changes the imported `INPUT.NU`. Use
**Download saved drive set** first if the disk contains your own work, and keep
the `.tds` file outside the browser profile.

1. Enter `EDIT INPUT.NU`.
2. Press Ctrl-F, type `'O'` including the quotes, and press Enter.
3. Press Ctrl-R, type `'Y'` including the quotes, and press Enter. The source
   should now contain `writeOutputByte('Y') else fail`.
4. Press Ctrl-S to save, then Ctrl-Q to quit.
5. Enter `NUC INPUT.NU`, then `INPUT`. The program prints `YK`.
6. Wait for **Working disk saved in this browser.** before reloading the page.
7. After reload, enter `B:` then `EDIT INPUT.NU`. The changed line should remain. Quit
   with Ctrl-Q and enter `INPUT` again; it should still print `YK`.

Use Ctrl, including on macOS, rather than Command for the editor shortcuts. If
the sample already contains `'Y'`, it was saved by an earlier session; choose a
different output character for another trial.

Ctrl-S saves into the emulated disk. The browser save-status message confirms
the separate persistent-storage operation. After a storage error, use **Download
latest checkpoint set** before leaving the page. It includes each drive's last
successful guest flush, which may be newer than browser storage. It excludes
unsaved editor text and unflushed writes. A checkpoint set can contain a newer B
checkpoint and an older D checkpoint; guest writes across both drives are not a
single transaction.

## Files and verified tool updates

Save and exit the guest program, open **Files**, acknowledge that
the program has exited, and click **Enter disk management**. Use **Drive to
view or edit** to select a configured drive for file imports, tool updates,
source projects and diagnostic mapping. This selector does not change CP/M's
current drive. Enter `B:` in the terminal to run guest commands on B; enter `A:`
to return. Published A/C are read-only; select a personal disk for imports,
editor output and tool updates.

File imports and ATOM, NUC or Edit updates are staged privately. Select **Stage
file imports** or a tool's **Stage update**, then **Apply and restart**.
Applying preserves the preceding complete drive set as a backup before
restarting CP/M. **Cancel changes** resumes the original machine. The file
listing shows committed files in user area 0, not the staged changes. Files use
CP/M 8.3 names; downloads include 128-byte record padding. Empty imports and
read-only replacements are rejected.

### Personal disks and live insertion

In **Disk box and published library**, **Create blank personal disk** adds an
empty disk to the box. Its **Insert** button mounts it in the selected drive.
**Eject selected drive** leaves that personal disk in the list, with its files
intact. Ejection does not reduce the configured slot count. **Make writable
copy of inserted disk** is an explicit copy operation; ordinary published
mounts do not create personal copies.

Before a live change, save and exit ordinary guest programs to CP/M. A program
that supports live swapping must close and flush its files, wait at a disk-change
prompt, then reset the changed drive's login state with BDOS 37 and reopen files.
The checkbox alone cannot make an open guest file safe to swap. Insertion and
ejection preserve CPU/RAM rather than restarting the guest.

Changing or ejecting A requires the system-disk guard. A subsequent warm boot
pauses until **Restore system disk to A** restores that configuration's retained
system image. It does not install this release's newer system. Historical
machines without that guard require the Files archive/restart workflow for A
changes. After an uncertain save, leave the paused machine intact and use the
offered retry or recovery downloads; do not clear site data.

### Historical machine layout changes

The Files geometry controls below remain available for writable historical
machines. They modify resident system bytes on A; they are not file updates to
the protected starter A image.

Download the saved drive set before changing the layout. In disk management, set
**Target two-MiB drive slots** to a number from 1 to 16 and choose **Stage drive
configuration**. Two or four slots are useful starting points. The confirmation
shows the new COM load capacity and identifies inserted media that a smaller
configuration would remove. **Apply and restart** retains the complete preceding
machine as a backup and installs the selected resident system on A. Tool
binaries are unchanged.

Existing two-MiB filesystems retain their bytes. Historical small and eight-MiB
media are migrated by filename only when all retained files fit. A failed
migration leaves the original machine unchanged. This conversion is explicit;
reloading a newer website does not convert saved disks.

Slots and inserted disks are separate. For example, sixteen slots permit A–P
while only A and P contain disks. Select an empty slot, click **Stage blank
selected drive**, import files as needed, then apply. A blank data disk has no
tools or source files. **Stage ejection of selected drive** removes its medium
on apply while preserving it in the preceding backup. Ejection leaves the slot
count and COM load capacity unchanged. This Files staging workflow keeps A
inserted; guarded live A ejection is a separate disk-box operation.

The active-machine summary lists configured slots, inserted media and the COM
load capacity. More configured slots reserve more guest memory, regardless of
whether disks are inserted. Two slots permit 58,368 bytes of COM loading;
sixteen permit 56,576 bytes. These are loader limits, not guarantees that every
program's stack and work buffers fit. The
[tool-lifetime report](reports/two-mib-tool-lifetimes.md) records tested cases.

Browser memory is a separate cost: sixteen inserted disks contain 32 MiB of
image data, with additional copies during management and saving. Desktop tests
measured a median sampled renderer peak of about 585 MiB while managing all
sixteen. Start with two or four slots and insert only the media you need; the
[memory report](reports/browser-management-memory.md) gives the workload and
measurement limits. These desktop results do not qualify phone or ESP32 memory.

### Retained eight-MiB A/B profiles

These operations are for an older saved machine or a deliberate change to its
disk layout. They do not describe the new two-MiB A/B/C/D setup.

Download the saved drive set before changing the disk layout. In disk
management, select drive A, then use one of these explicit changes:

- **Stage upgrade of drive A to 8 MiB** migrates the files to the one-drive
  eight-MiB system. It does not enable B.
- **Stage eight MiB A/B system** installs the A/B resident system on A. Legacy
  files are migrated to eight MiB; an existing eight-MiB A retains its file
  area. Files in all user areas are preserved, although Files displays user 0.

For two drives, follow the A/B operation with **Stage blank B**, then **Apply
and restart**. Each drive has eight MiB of image capacity, with 8,355,840 bytes
initially available for files after system and directory space. Blank B has no
tools, source files or operating-system bytes. Select B in Files to import
sources and stage the tools you need, apply, then enter `B:` in the terminal.
The assemble/edit/compile workflow above also works on B once those files and
tools are present there.

Instead of creating blank B, select B and use **Stage disk image** with an
eight-MiB image. Attaching B does not adapt its system area. **Stage removal of
B** removes it on apply, with the preceding complete set backed up; A's bytes
and A/B resident profile remain unchanged.

## Backup and restore

Expand **Downloads and recovery** for saved-disk, drive-set and checkpoint
downloads. These controls are collapsed to leave room for the terminal.
Complete disk-box recovery remains in **Disk box and published library**.

**Download complete disk-box recovery** exports a `.tdbr` file containing raw
disk-box records, personal disk bytes, historical storage and backups, including
ejected disks. Keep it outside the browser for recovery. It is a raw recovery
package, not a `.tds` archive accepted by **Stage complete drive-set archive**.

**Download saved drive set** exports a `.tds` archive containing the exact
bootstrap, resident-profile label and every inserted image. Two-MiB archives
also preserve configured empty slots and each medium's identity. This is the
backup for reopening that selected disk arrangement; it does not include other
configurations or ejected disks elsewhere in the box. With A ejected, use the
complete disk-box recovery download. **Download saved disk A** or
**Download saved disk B** (or the selected C–P drive) exports only that
disk image; it does not include the bootstrap or profile. The corresponding
checkpoint downloads use guest-flushed data rather than the last durable browser
copy.

To test a `.tds` backup, open Triptych in a separate browser profile. Enter disk
management, choose **Stage complete drive-set archive**, select the file, then
**Apply and restart** and close Files. Inspect the source and run the program on
its original drive. Restoring replaces the complete set, including the
configured count and empty slots; it is not a merge. A backup row's **Stage
restore** also restores the complete set, regardless of the Files drive
selector.

For a single `.img` backup, use **Stage disk image** on the intended drive. For
a two-MiB machine, configure its slots first; a raw image does not carry a
machine profile or medium identity. Importing it creates a new medium identity.
For historical A images, explicitly select the **A image resident profile** if
it differs from the current one. A historical single-drive image needs **Legacy
E400, one drive**; first stage removal of B if B is attached. Leave **Adapt
external image with this release's CCP/BDOS/BIOS (changes system bytes)**
unchecked for exact disk-byte restoration. Image size alone does not identify
its resident system. A `.tds` archive avoids this manual bootstrap/profile
selection.

Select adaptation only for a deliberate system update: it replaces A's resident
system bytes with this release's verified system for the selected profile while
preserving its file area. Applying retains the preceding set as a backup.

If the guest is stuck or cannot boot, **Recover from saved disk** permits
replacement after explicit consent to discard unsaved state on apply. The
[recovery guide](browser-recovery.md) covers this path, raw downloads and
website redeployment. Do not clear site data, delete IndexedDB or downgrade
storage to recover work. **Reset** is a machine reset, not a backup
operation.

### Multi-source adventure

Inside disk management, select the writable drive containing your tools, such
as B prepared above. **Stage adventure starter** stages `IO.NU`, `MAIN.NU` and
`BUILD.JSN`. **Prepare build**
creates the generated `GAME.NU` input and `GAME.MAP` source map. **Apply and
restart**, close Files, select that drive in CP/M, then run `NUC GAME.NU` and
`GAME`. The winning keys are `E`, `T`, `W`; `Q` quits.

To change the program, use `EDIT MAIN.NU`, find `CAVE` with Ctrl-F and replace
it with `BASE` using Ctrl-R. Save with Ctrl-S and quit with Ctrl-Q. Enter disk
management again on the same drive, prepare the build, apply, and recompile. The
game now prints `BASE>`. Edit the maintained sources, not the generated build
file.

If compilation reports an error, paste the full Nucleus diagnostic into Files
and choose **Locate in saved sources** on the same drive. Mapping is available
only while source records and the generated build match the saved map. It does
not identify an older diagnostic's build automatically or include unsaved editor
RAM.

## Commands and limits

The supported CCP commands are `DIR`, `TYPE`, `ERA`, `REN`, `SAVE` and `USER`.
For normal development, start with `DIR`, `TYPE filename`, `ATOM source.asm`,
`NUC source.nu`, `EDIT filename`, and a program name without `.COM` on the
prepared writable drive. `ERA` deletes files; keep backups before experimenting
with disk-changing commands.

The browser terminal is 80×24. The configurable profile supports one to sixteen
slots with two-MiB media. The retained large-disk profiles
support eight-MiB A alone or A with optional eight-MiB B. Compatibility covers
the published feature matrix and tested application corpus, not every CP/M
application. See the [tool-arena report](reports/eight-mib-tool-arenas.md) for
the measured tool boundaries and exclusions. Physical mobile-keyboard behavior
and ESP32 storage/power-loss behavior remain unqualified. No board is needed for
this browser session.
