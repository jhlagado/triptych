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
import tempfile
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


def prove(exit_method, working_drives=None, reopen=False):
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
        environment.pop("TRIPTYCH_CPM22_WORK_DISK_B", None)
        environment.pop("TRIPTYCH_CPM22_IMAGE", None)
        environment.pop("TRIPTYCH_CPM_CCP", None)
        environment.pop("TRIPTYCH_CPM_BOOTSTRAP_PROFILE", None)
        if working_drives is not None:
            environment["TRIPTYCH_CPM22_WORK_DISK"] = str(working_drives[0])
            environment["TRIPTYCH_CPM22_WORK_DISK_B"] = str(working_drives[1])
            environment["TRIPTYCH_CPM_BOOTSTRAP_PROFILE"] = "triptych-cpu-v0.1-8m-ab"
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--session", str(report_write)], cwd=ROOT,
            stdin=slave, stdout=slave, stderr=slave, env=environment,
            preexec_fn=controlling_terminal,
            pass_fds=(report_write,),
        )
        os.close(report_write)
        report_write = None
        opening = wait_for(master, process, b"\r\nA>")
        if working_drives is not None:
            assert b"Working drive A:" in opening and b"Working drive B:" in opening, opening
            assert b"Selected bootstrap profile: triptych-cpu-v0.1-8m-ab" in opening, opening
        active = termios.tcgetattr(slave)
        assert not active[0] & termios.IXON, "host intercepts guest Ctrl-S/Ctrl-Q"
        assert not active[0] & termios.IXOFF, "host injects software flow-control bytes"
        assert not active[0] & termios.ICRNL, "host translates guest carriage returns"
        assert not active[1] & termios.OPOST, "host translates guest output bytes"
        assert not active[3] & (termios.ICANON | termios.ECHO), "host buffers or echoes guest input"
        assert active[3] & termios.ISIG, "documented Ctrl-C host exit is disabled"
        if working_drives is None:
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
        else:
            for command, expected in ((b"TYPE SIDE.TXT\r", b"DRIVE-A-UNCHANGED"),
                                      (b"TYPE B:SIDE.TXT\r", b"DRIVE-B-UNCHANGED")):
                os.write(master, command)
                response = wait_for(master, process, b"\r\nA>")
                assert expected in response, response
            os.write(master, b"B:\r")
            wait_for(master, process, b"\r\nB>")
            os.write(master, b"TYPE A:SIDE.TXT\r")
            response = wait_for(master, process, b"\r\nB>")
            assert b"DRIVE-A-UNCHANGED" in response, response
            if not reopen:
                os.write(master, b"EDIT PTY.TXT\r")
                wait_for(master, process, b"^Q Quit")
                os.write(master, b"Native B PTY\x13\x11")
                # EDIT returns by warm boot; the default drive must remain B.
                wait_for(master, process, b"\r\nB>")
            os.write(master, b"TYPE PTY.TXT\r")
            response = wait_for(master, process, b"\r\nB>")
            assert b"Native B PTY" in response, response
            os.write(master, b"TYPE A:PTY.TXT\r")
            response = wait_for(master, process, b"\r\nB>")
            assert b"A FILE MUST STAY" in response, response
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


def prove_large_ab():
    """Private verified fixtures; requires an already-built WASM CpmDisk API."""
    with tempfile.TemporaryDirectory(prefix="triptych-native-ab-pty-") as directory:
        # Build only private images. No Rust/WASM/shared-output build is invoked.
        subprocess.run(["node", "--input-type=module", "-e", r"""
import {buildCpmDistribution} from './tools/lib/cpm-distribution.mjs';
import {buildLargeAbSystem} from './tools/lib/large-ab-system.mjs';
import {createRequire} from 'node:module';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const {CpmDisk} = createRequire(import.meta.url)('./dist/wasm/triptych_host_wasm.js');
const distribution = await buildCpmDistribution(process.cwd(), {allowDirty:true});
const system = await buildLargeAbSystem(process.cwd(), distribution);
for (const [drive, name] of ['a.img','b.img'].entries()) {
  const source = new CpmDisk(distribution.disk);
  let migrated;
  try { migrated = source.migrate_to_eight_mib(system.bytes); }
  finally { source.free(); }
  const disk = new CpmDisk(migrated);
  try {
    disk.add_import('SIDE.TXT', Buffer.from(`DRIVE-${drive ? 'B' : 'A'}-UNCHANGED\r\n`));
    if (!drive) disk.add_import('PTY.TXT', Buffer.from('A FILE MUST STAY\r\n'));
    const bytes = disk.export_candidate();
    // Saved system padding differs deliberately from freshly generated bytes.
    bytes[0x3fff] = drive ? 0x52 : 0x51;
    await writeFile(join(process.argv[1], name), bytes);
  } finally { disk.free(); }
}
""", directory], cwd=ROOT, check=True, timeout=30)
        drives = [Path(directory) / name for name in ("a.img", "b.img")]
        before = [path.read_bytes() for path in drives]
        prove("ctrl-c", drives)
        after = [path.read_bytes() for path in drives]
        assert after[0] == before[0], "B save changed the complete A image"
        assert after[1] != before[1], "B save did not reach its own image"
        for drive in (0, 1):
            assert after[drive][:16384] == before[drive][:16384], "saved system bytes changed"
        prove("sigterm", drives, reopen=True)
        assert [path.read_bytes() for path in drives] == after, "fresh reopen changed saved images"
        print("Native A/B PTY: explicit profile, cross-drive access, B save/warm boot, exact A/system preservation and fresh-process reopen passed")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--session":
        sys.exit(session_supervisor(int(sys.argv[2])))
    if sys.argv[1:] == ["--large-ab"]:
        prove_large_ab()
        sys.exit(0)
    if len(sys.argv) != 1:
        raise SystemExit("usage: python3 tools/prove-native-terminal.py [--large-ab]")
    for method in ("ctrl-c", "sigterm"):
        prove(method)
        print(f"Native PTY {method}: byte-preserving input/output and terminal restoration passed")
