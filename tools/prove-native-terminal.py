"""Exercise the public native launcher on a real Unix pseudo-terminal."""

import fcntl
import os
from pathlib import Path
import pty
import select
import signal
import subprocess
import sys
import termios
import time


ROOT = Path(__file__).resolve().parent.parent


def terminal_configuration(fd):
    attributes = termios.tcgetattr(fd)
    # Darwin sets PENDIN while returning buffered input to canonical mode.
    # Compare all configuration bits and control characters, not this status bit.
    attributes[3] &= ~getattr(termios, "PENDIN", 0)
    return attributes


def session_supervisor(report_fd):
    """Keep the controlling session alive while checking post-launcher termios."""
    child = subprocess.Popen(["node", "tools/run-cpm22-native.mjs"], cwd=ROOT)
    # Ctrl-C already reaches the foreground process group. SIGTERM sent by the
    # outer test targets this supervisor, so explicitly forward that signal.
    signal.signal(signal.SIGINT, lambda *_: None)
    signal.signal(signal.SIGTERM, lambda *_: child.send_signal(signal.SIGTERM))
    code = child.wait()
    os.write(report_fd, repr(terminal_configuration(0)).encode("ascii"))
    os.close(report_fd)
    return code


def wait_for(master, process, expected, timeout=30):
    output = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            output.extend(os.read(master, 65536))
            if expected in output:
                return bytes(output)
        if process.poll() is not None:
            raise AssertionError(f"launcher exited {process.returncode}: {output!r}")
    raise AssertionError(f"timed out waiting for {expected!r}: {output[-1000:]!r}")


def prove(exit_method):
    master, slave = pty.openpty()
    report_read, report_write = os.pipe()
    process = None
    try:
        initial = termios.tcgetattr(slave)
        initial[0] |= termios.IXON | termios.IXOFF | termios.ICRNL
        initial[1] |= termios.OPOST | termios.ONLCR
        initial[3] |= termios.ICANON | termios.ECHO | termios.ISIG
        termios.tcsetattr(slave, termios.TCSANOW, initial)
        saved = terminal_configuration(slave)

        def controlling_terminal():
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)

        environment = dict(os.environ)
        environment.pop("TRIPTYCH_CPM22_WORK_DISK", None)
        environment.pop("TRIPTYCH_CPM22_IMAGE", None)
        environment.pop("TRIPTYCH_CPM_CCP", None)
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--session", str(report_write)], cwd=ROOT,
            stdin=slave, stdout=slave, stderr=slave, env=environment,
            preexec_fn=controlling_terminal,
            pass_fds=(report_write,),
        )
        os.close(report_write)
        report_write = None
        wait_for(master, process, b"\r\nA>")
        active = termios.tcgetattr(slave)
        assert not active[0] & termios.IXON, "host intercepts guest Ctrl-S/Ctrl-Q"
        assert not active[0] & termios.IXOFF, "host injects software flow-control bytes"
        assert not active[0] & termios.ICRNL, "host translates guest carriage returns"
        assert not active[1] & termios.OPOST, "host translates guest output bytes"
        assert not active[3] & (termios.ICANON | termios.ECHO), "host buffers or echoes guest input"
        assert active[3] & termios.ISIG, "documented Ctrl-C host exit is disabled"
        os.write(master, b"DIR HELLO.ASM\r")
        response = wait_for(master, process, b"\r\nA>")
        assert b"HELLO    ASM" in response, response
        assert b"\r\r\r\n" not in response, "host added an extra carriage return"
        os.write(master, b"EDIT PTY.TXT\r")
        wait_for(master, process, b"^Q Quit")
        os.write(master, b"Native PTY\x13\x11")
        wait_for(master, process, b"\r\nA>")
        os.write(master, b"TYPE PTY.TXT\r")
        saved_text = wait_for(master, process, b"\r\nA>")
        assert b"Native PTY" in saved_text, "Ctrl-S did not save the guest file"
        if exit_method == "ctrl-c":
            os.write(master, b"\x03")
        else:
            process.send_signal(signal.SIGTERM)
        code = process.wait(timeout=10)
        assert code == (130 if exit_method == "ctrl-c" else 143), code
        restored = os.read(report_read, 16384).decode("ascii")
        assert restored == repr(saved), f"terminal restore mismatch: saved={saved!r}, restored={restored}"
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        os.close(master)
        os.close(slave)
        os.close(report_read)
        if report_write is not None:
            os.close(report_write)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--session":
        sys.exit(session_supervisor(int(sys.argv[2])))
    for method in ("ctrl-c", "sigterm"):
        prove(method)
        print(f"Native PTY {method}: byte-preserving input/output and terminal restoration passed")
