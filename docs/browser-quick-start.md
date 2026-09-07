# Browser development session

This guide describes the eight-MiB A/B interface and version-three drive-set
storage. The [published releases](https://github.com/jhlagado/triptych/releases)
record qualified revisions, hosted test results and recovery downloads for the
[Triptych website](https://jhlagado.github.io/triptych/). A development checkout
can contain changes that have not yet been deployed. The
[browser A/B report](reports/eight-mib-browser-ab.md) records implementation
and pre-release acceptance evidence.

In a desktop browser, wait for `A>` and click the terminal to type. A fresh
profile starts with the supplied single-drive disk. Previously saved media
reopen automatically, so their files and drive layout may differ. Opening a
new website release does not silently replace their operating system or tools.

## Play Caverns

Fresh disks include `CAVERNS.COM`, John Hardy's revised 1982–83 adventure.
At `A>`, type `CAVERNS` and press Enter. The full story and current rules appear
at startup; `HELP` repeats them. Space or Enter advances each page; Q or Escape
skips the remaining explanation. `INVENTORY`, `INVENT`, `I` and `LIST` show what
you carry.

Use `SAVE CAMP` to save a position and `LOAD CAMP` to return to it. `QUIT`, then
`N`, returns to CP/M. Wait for the browser's saved-disk status before closing or
reloading the page, and download a disk backup to keep a copy outside the browser.

An existing saved disk is preserved. If it lacks the game, use Files to install
`CAVERNS.COM` from the supplied application catalogue, then apply the change.
Back up your disk first. Installing the program does not require deleting your
saved games. The [upstream player guide](https://github.com/jhlagado/caverns80/blob/cpm-caverns/docs/player-guide.md)
is safe to read before playing; development audits and walkthrough tests contain
spoilers.

## Assemble and run

On the supplied disk, enter each command followed by Enter:

```text
ATOM HELLO.ASM
HELLO
```

ATOM reports `HELLO.COM written`; the program prints `Hello from ATOM`.

## Edit, compile and reopen

This exercise changes the supplied `INPUT.NU`. Use **Download saved drive set**
first if the disk contains your own work, and keep the `.tds` file outside the
browser profile.

1. Enter `EDIT INPUT.NU`.
2. Press Ctrl-F, type `'O'` including the quotes, and press Enter.
3. Press Ctrl-R, type `'Y'` including the quotes, and press Enter. The source
   should now contain `writeOutputByte('Y') else fail`.
4. Press Ctrl-S to save, then Ctrl-Q to quit.
5. Enter `NUC INPUT.NU`, then `INPUT`. The program prints `YK`.
6. Wait for **Working disk saved in this browser.** before reloading the page.
7. After reload, enter `EDIT INPUT.NU`. The changed line should remain. Quit
   with Ctrl-Q and enter `INPUT` again; it should still print `YK`.

Use Ctrl, including on macOS, rather than Command for the editor shortcuts.
If the sample already contains `'Y'`, it was saved by an earlier session;
choose a different output character for another trial.

Ctrl-S saves into the emulated disk. The browser save-status message confirms
the separate persistent-storage operation. After a storage error, use
**Download latest checkpoint set** before leaving the page. It includes each
drive's last successful guest flush, which may be newer than browser storage.
It excludes unsaved editor text and unflushed writes. A checkpoint set can
contain a newer A checkpoint and an older B checkpoint; guest writes across
both drives are not a single transaction.

## Files and verified tool updates

Save and exit the guest program, open **Files and recovery**, acknowledge that
the program has exited, and choose **Enter disk management**. Use **Drive to
view or edit** to select A or B for file imports, tool updates, source projects
and diagnostic mapping. This selector does not change CP/M's current drive.
Enter `B:` in the terminal to run guest commands on B; enter `A:` to return.

File imports and ATOM, NUC or Edit updates are staged privately. Select
**Stage file imports** or a tool's **Stage update**, then **Apply and restart**.
Applying preserves the preceding complete drive set as a backup before
restarting CP/M. **Cancel changes** resumes the original machine. The file
listing shows committed files in user area 0, not the staged changes. Files
use CP/M 8.3 names; downloads include 128-byte record padding. Empty imports
and read-only replacements are rejected.

### Add capacity and drive B

Download the saved drive set before changing the disk layout. In disk
management, select A and choose one of these explicit changes:

- **Stage upgrade of drive A to 8 MiB** migrates the files to the one-drive
  eight-MiB system. It does not enable B.
- **Stage eight MiB A/B system** installs the A/B resident system on A. Legacy
  files are migrated to eight MiB; an existing eight-MiB A retains its file
  area. Files in all user areas are preserved, although Files displays user 0.

For two drives, follow the A/B operation with **Stage blank B**, then
**Apply and restart**. Each drive has eight MiB of image capacity, with
8,355,840 bytes initially available for files after system and directory space.
Blank B has
no tools, source files or operating-system bytes. Select B in Files to import
sources and stage the tools you need, apply, then enter `B:` in the terminal.
The assemble/edit/compile workflow above also works on B once those files and
tools are present there.

Instead of creating blank B, select B and use **Stage disk image** with an
eight-MiB image. Attaching B does not adapt its system area. **Stage removal of
B** removes it on apply, with the preceding complete set backed up; A's bytes
and A/B resident profile remain unchanged.

## Backup and restore

**Download saved drive set** exports a `.tds` archive containing the exact
bootstrap, resident-profile label, A image and optional B image. This is the
complete backup for reopening the same disk arrangement. **Download saved disk
A** or **Download saved disk B** exports only the selected disk image; it does
not include the bootstrap or profile. The corresponding checkpoint downloads
use guest-flushed data rather than the last durable browser copy.

To test a `.tds` backup, open Triptych in a separate browser profile. Enter
disk management, choose **Stage complete drive-set archive**, select the file,
then **Apply and restart** and close Files. Inspect the source and run the
program on its original drive. Restoring replaces the complete set, including
whether B is attached; it is not a merge. A backup row's **Stage restore** also
restores the complete set, regardless of the Files drive selector.

For a single `.img` backup, use **Stage disk image** on the intended drive.
For A, explicitly select its **A image resident profile** if it differs from
the current one. A historical single-drive image needs **Legacy E400, one
drive**; first stage removal of B if B is attached. Leave **Adapt external
image with this release's CCP/BDOS/BIOS (changes system bytes)** unchecked for
exact disk-byte restoration. Image size alone does not identify its resident
system. A `.tds` archive avoids this manual bootstrap/profile selection.

Select adaptation only for a deliberate system update: it replaces A's
resident system bytes with this release's verified system for the selected
profile while preserving its file area. Applying retains the preceding set as
a backup.

If the guest is stuck or cannot boot, **Recover from saved disk** permits
replacement after explicit consent to discard unsaved state on apply. The
[recovery guide](browser-recovery.md) covers this path, raw downloads and website
redeployment. Do not clear site data, delete IndexedDB or downgrade storage to
recover work. **Reset machine** is a machine reset, not a backup operation.

### Multi-source adventure

Inside disk management, select the drive containing your tools. **Stage
adventure starter** stages `IO.NU`, `MAIN.NU` and `BUILD.JSN`. **Prepare build**
creates the generated `GAME.NU` input and `GAME.MAP` source map. **Apply and
restart**, close Files, select that drive in CP/M, then run `NUC GAME.NU` and
`GAME`. The winning keys are `E`, `T`, `W`; `Q` quits.

To change the program, use `EDIT MAIN.NU`, find `CAVE` with Ctrl-F and replace
it with `BASE` using Ctrl-R. Save with Ctrl-S and quit with Ctrl-Q. Enter disk
management again on the same drive, prepare the build, apply, and recompile.
The game now prints `BASE>`. Edit the maintained sources, not the generated
build file.

If compilation reports an error, paste the full Nucleus diagnostic into Files
and choose **Locate in saved sources** on the same drive. Mapping is available
only while source records and the generated build match the saved map. It does
not identify an older diagnostic's build automatically or include unsaved
editor RAM.

## Commands and limits

The supported CCP commands are `DIR`, `TYPE`, `ERA`, `REN`, `SAVE` and `USER`.
For normal development, start with `DIR`, `TYPE filename`, `ATOM source.asm`,
`NUC source.nu`, `EDIT filename`, and a program name without `.COM`. `ERA`
deletes files; keep backups before experimenting with disk-changing commands.

The baseline is drive A and an 80×24 terminal. The explicit large-disk profiles
support eight-MiB A alone or A with optional eight-MiB B. Compatibility covers
the published feature matrix and tested application corpus, not every CP/M
application. See the [tool-arena report](reports/eight-mib-tool-arenas.md) for
the measured tool boundaries and exclusions. Physical mobile-keyboard behavior
and ESP32 storage/power-loss behavior remain unqualified. No board is needed
for this browser session.
