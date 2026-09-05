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
