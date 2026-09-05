# Browser development session

Open [Triptych](https://jhlagado.github.io/triptych/) in a desktop browser and
wait for `A>`. Click the terminal to type. A previously saved browser disk is
restored automatically, so its files may differ from a fresh distribution.

## Assemble and run

On the supplied disk, enter each command followed by Enter:

```text
ATOM HELLO.ASM
HELLO
```

ATOM reports `HELLO.COM written`; the program prints `Hello from ATOM`.

## Edit, compile and reopen

This exercise changes the supplied `INPUT.NU`. Download a backup first if it
contains your own work.

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

## Backup and restore

**Download working disk** exports the whole disk, including source and compiled
programs. Keep that file outside browser storage. Guest Ctrl-S saves into the
emulated disk; the browser save-status message confirms the separate persistent
storage operation. A storage-error message means reload-safe saving has not
been confirmed; download a recovery copy before leaving the page.

To test a backup, open Triptych in a separate browser profile and select the
download using **Open CP/M disk image**. Wait for `A>`, then inspect the source
with `TYPE INPUT.NU` or `EDIT INPUT.NU` and run `INPUT`. Back up the current disk
before selecting another image. Importing a disk selects that disk's files;
it is not a merge. Clearing browser site data can remove the browser's saved
copy. **Reset machine** is a machine reset, not a backup operation.

## Commands and limits

The supported CCP commands are `DIR`, `TYPE`, `ERA`, `REN`, `SAVE` and `USER`.
For normal development, start with `DIR`, `TYPE filename`, `ATOM source.asm`,
`NUC source.nu`, `EDIT filename`, and a program name without `.COM`. `ERA`
deletes files; keep backups before experimenting with disk-changing commands.

The baseline is drive A, fixed CP/M disk geometry and an 80×24 terminal.
Compatibility covers the published feature matrix and tested application
corpus, not every CP/M application. Desktop Chromium, macOS native and Linux
CI have acceptance evidence. Physical mobile-keyboard behavior and ESP32
storage/power-loss behavior remain unqualified. No board is needed for this
browser session.

## Local Files preview

The `browser-development-workspace` branch adds **Files and recovery**. These
controls are locally tested but have not yet replaced the hosted version
described above.

After saving and exiting Edit, open Files, acknowledge that the guest program
has exited, and choose **Enter disk management**. File imports and selected
ATOM, NUC or Edit updates are staged privately. **Apply and restart** preserves
the preceding saved disk as a backup and restarts CP/M with the changed disk.
Cancel resumes the original CPU. Files use CP/M 8.3 names; downloads include
record padding. Empty imports and read-only replacements are rejected.

**Download saved disk** exports the committed browser copy. **Download latest
checkpoint** can retain newer guest-flushed data after a browser save failure;
it excludes unsaved editor text and later unflushed writes. Keep downloaded
copies outside browser storage.

If a guest is stuck or an imported disk will not boot, the expandable recovery
section permits **Recover from saved disk** after explicit consent to discard
unsaved state when applying a replacement. A backup or downloaded image can then
be staged and applied. Leave system adaptation unchecked for exact restoration.
This recovery path does not require a healthy guest or clearing site data.
The [recovery guide](browser-recovery.md) distinguishes disk restoration from
website redeployment and explains the retained recovery archive.

Existing saved disks keep their original CCP, BDOS and BIOS bytes: opening the
new website does not silently upgrade their operating system. A fresh profile
uses the current distribution. To adapt an existing disk deliberately, download
it first, stage that image in Files with **Adapt external image with this release's
CCP/BDOS/BIOS** selected, then apply.
That replaces its resident system area and preserves its file area; the displaced
disk is backed up. Leave adaptation unchecked when exact restoration is intended.

### Multi-source adventure

Inside disk management, **Stage adventure starter** stages `IO.NU`, `MAIN.NU`
and `BUILD.JSN`. **Prepare build** creates the generated `GAME.NU` input and
`GAME.MAP` source map. **Apply and restart**, close Files, then run
`NUC GAME.NU` and `GAME`. The winning keys are `E`, `T`, `W`; `Q` quits.

To change the program, use `EDIT MAIN.NU`, find `CAVE` with Ctrl-F and replace
it with `BASE` using Ctrl-R. Save with Ctrl-S and quit with Ctrl-Q. Enter disk
management again, prepare the build, apply, and recompile. The game now prints
`BASE>`. Edit the maintained sources, not the generated build file.

If compilation reports an error, paste the full Nucleus diagnostic into Files
and choose **Locate in saved sources**. Mapping is available only while source
records and the generated build match the saved map. It does not identify an
older diagnostic's build automatically or include unsaved editor RAM.
