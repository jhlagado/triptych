# Keyboard-driven file manager and IDE direction

Recorded 7 September 2026 from the Triptych System discussion. This is a
design brief, not an implemented feature or a recovered copy of the earlier
missing conversation. Exact key bindings and application packaging remain open.

## Agreed interaction model

The starting point is a Norton Commander-style file manager for the Z80
CP/M environment. It provides two independently selected file locations and
quick keyboard access to file operations. A project might use drive F while
the other location contains tools or files to copy into that project.

Two locations do not require two simultaneously visible panes. A wide display
can show both; a narrow display can show the active location and an indication
of the other location. Toggling preserves each location's selection and scroll
position. Forty columns must not be excluded merely because two panes do not
fit. Neither 64 nor 80 columns is a settled minimum.

For a copy operation, the active location supplies the selected source files;
the other location supplies the destination. The interface must identify both
before a transfer. Switching locations reverses those roles for subsequent
commands, without changing a transfer already in progress.

## Keyboard and menus

All essential operations must be available without a mouse or function-key
row. The baseline uses ordinary typing, Tab, arrows, Enter, Escape and a small
set of control-key commands. Tab is the proposed location-switch key. Menus provide keyboard
access to commands and display their shortcuts; users need not memorise the
whole command set before starting.

Function keys are optional shortcuts for the same actions. Compact Bluetooth
keyboards and terminal clients with intercepted shortcuts must remain usable.
The key map must include navigation, location selection, file selection,
copying, renaming/moving, deletion, viewing, editing, help and exit. This list
defines the design coverage, not a claim that every operation belongs in the
first prototype.

Before fixing bindings, test the actual bytes delivered by the browser and
native terminal paths. Account for control-key aliases, terminal flow control,
browser shortcuts, incomplete escape sequences and Escape used by itself.
Menu access and cancellation must remain available on the baseline keyboard.

## Platform and development scope

ANSI terminal operation is a lasting baseline. A future ESP32 VDP command
interface may provide another display implementation; it must preserve the
file-operation and keyboard semantics. Pixel resolution, fonts, terminal-size
discovery and the exact video protocol are separate design work.

This is intended as a guest-side application, distinct from the browser's host
Files panel. Triptych is the initial integration target. The permanent source
repository, implementation language and portable platform interface are still
to be selected; this brief does not assign the application to the BIOS or BDOS.
The repository options include extending Edit or keeping Edit independent and
creating a separate file-manager/IDE repository. No extraction or integration
decision has been made. Assembly work uses ATOM.

The later Turbo Pascal-style IDE workflow is edit, compile, jump to an error,
correct it, run, and return to the editing position. It builds on file management
and the existing independent Edit, ATOM and Nucleus tools. Bank switching and
ESP32 hardware are not prerequisites for the initial file-manager prototype.

## Proposed first proof

A keyboard-only prototype should select two drive locations, toggle between
them, select a file and copy it to the other location. A one-pane prototype is
sufficient; a later two-pane presentation should use the same commands and
retained selections.
The copy must leave the source intact, verify the destination contents and
report failure without claiming success. Replacement and deletion need explicit
confirmation; cancellation must leave files unchanged.

Next, define a compact command/key table and a guest key-input test. Exercise
the resulting file-manager workflow headlessly, then through the browser
terminal. Defer screen-width optimisation and the full IDE until those
interactions are usable.
