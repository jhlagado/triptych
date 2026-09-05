# Hill Key

A two-room Nucleus adventure: fetch the key from the hill, then bring it back
to the cave to win. The original sample sources are licensed under
GPL-3.0-or-later, like Triptych; see the repository's [licence](../../LICENSE).

## Source files and build

`IO.NU` contains the byte-output routine. `MAIN.NU` contains the game state,
commands and win condition. `BUILD.JSN` lists them in dependency order and
names the generated `GAME.NU` input and `GAME.MAP` source map. The manifest
contains JSON, but its `.JSN` extension fits CP/M's three-character limit.

This is a host-assisted build. The host packages the two maintained source
files into one generated input; released `NUC.COM` still reads one physical
source file. There are no CP/M imports or dependency searches. A downloaded
prebuilt `GAME.NU` can demonstrate the game, but cannot replace the packaging
step after editing either maintained source file.

After importing the three project files and preparing the bundle through the
host's project-packaging control, the terminal commands are:

```text
A>NUC GAME.NU
A>GAME
```

Edit `IO.NU` or `MAIN.NU`, not the generated `GAME.NU`. Save and exit EDIT,
prepare a new bundle, and compile again. In the browser, use **Files and recovery**,
acknowledge that the guest program has exited, and enter disk management.
**Stage adventure starter** imports these three files; **Prepare build** generates
the bundle and map; **Apply and restart** commits them with a disk backup.

## Playing

Commands are single uppercase keys; Enter is unnecessary. `E` goes to the hill,
`W` goes to the cave, `T` takes the key when on the hill, and `Q` quits. The
winning sequence is `E`, `T`, `W`. Taking at the cave prints a hint. Other keys
print the command reminder. CR and LF make no game-state change; the current
room prompt is drawn again. Movement at either boundary stays in that room,
and taking an already collected key has no additional effect.

Winning and quitting both return to `A>`. Running `GAME` again starts a fresh
game with no key.

## Edit and rebuild exercise

`EDIT MAIN.NU` opens the game source. Ctrl-F with `CAVE`, then Ctrl-R with
`BASE`, changes the starting-room prompt. Ctrl-S saves; Ctrl-Q exits. After
preparing the bundle again and running `NUC GAME.NU`, `GAME` prints `BASE>`.
The win message remains unchanged because it uses lowercase `cave`.

## Verification boundary

The sample was compiled by released CP/M NUC 0.3.1 and run on retained WASM
and macOS native hosts with the corrected Portable CP/M CCP. Thirty-one
transcript checkpoints and all three final disk images matched between hosts.
The replay covered winning, quitting, input edge cases, the actual EDIT change,
repackaging and recompilation. A later syntax error returned to the prompt and
preserved the preceding runnable program without temporary publication files.

The permanent `tools/prove-nucleus-adventure.mjs` uses the product source bundler
and runs as part of `npm run check`. Separate browser tests exercise the packaging
controls, edit/build/run, selected tool updates, reload, disk download and exact
reopening in another browser profile and the native host. These are local host
proofs, not physical-phone or ESP32 measurements. Hosted-release evidence is
recorded in the [integration report](../../docs/reports/browser-workspace-integration.md).
