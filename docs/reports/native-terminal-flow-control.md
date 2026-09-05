# Native terminal flow-control checkpoint

The launcher previously retained host software flow control and output
translation. A real pseudo-terminal test failed before the fix because IXON
was enabled: the host could intercept Edit's Ctrl-S and Ctrl-Q.

The launcher now disables IXON, IXOFF and OPOST alongside canonical input,
local echo and CR-to-LF input translation. Ctrl-C remains the documented host
exit; it is not delivered as a guest warm-boot request. SIGTERM also exits the
host. The saved terminal configuration is restored on the tested exit paths.

`python3 tools/prove-native-terminal.py` passed both paths on macOS. It boots
the public launcher, runs DIR, edits and saves PTY.TXT using Ctrl-S, quits Edit
using Ctrl-Q, reads the file back, and checks terminal configuration after exit.
The Python supervisor keeps the controlling session alive for that final check.
Darwin's PENDIN status bit is excluded; all other termios fields and control
characters are compared. No Linux PTY result is claimed by this local run.

An independent reviewer inspected the fix and privately probed a signal during
startup. No damaging restoration defect was demonstrated. The review suggested
explicit IXOFF setup/assertions, which the final proof includes.

Run `npm run proof:native-terminal` with Python 3 and the pinned Rust toolchain.
This command is also included in the root check. These host tests do not qualify
physical USB serial hardware, SD power-loss behavior, or the complete S6 parity
gate.

The complete root check passed locally after this change with historical
assembler imports blocked: 176 Vitest tests, seven real-browser tests, both
native PTY paths, the resident-system checks and the Rust checks/builds.
