"""Prove saved-archive native launch and terminal restoration on real Unix PTYs.

Inputs are already-built artifacts. This proof never assembles, builds, repacks
session disks, or removes evidence. Session images remain raw recovery data.
"""

import argparse
import fcntl
import hashlib
import json
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
LAUNCHER = ROOT / "tools/run-saved-machine-native.mjs"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            value.update(chunk)
    return value.hexdigest()


def terminal_configuration(fd):
    attributes = termios.tcgetattr(fd)
    # Darwin's PENDIN is a buffered-input status bit, not terminal configuration.
    # All other flags, speeds and control characters are compared exactly.
    attributes[3] &= ~getattr(termios, "PENDIN", 0)
    return attributes


def supervisor(report_fd, arguments):
    """Keep the controlling session alive until restored termios is reported."""
    signal.signal(signal.SIGINT, lambda *_: None)
    child = subprocess.Popen(["node", str(LAUNCHER), *arguments], cwd=ROOT)
    signal.signal(signal.SIGTERM, lambda *_: child.send_signal(signal.SIGTERM))
    code = child.wait()
    os.write(report_fd, repr(terminal_configuration(0)).encode("ascii"))
    os.close(report_fd)
    return code


def archive_metadata(archive):
    """Use the production strict decoder; this JSON is proof evidence only."""
    code = r"""
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
const {decodeSavedMachineArchive}=await import(process.argv[1]);
const snapshot=await decodeSavedMachineArchive(await readFile(process.argv[2]),webcrypto);
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
if(snapshot.schema!=='triptych-drive-set-v4'||snapshot.configuredCount!==16||!snapshot.slots[15])
  throw new Error('This proof requires a real sixteen-slot archive with A and P inserted.');
console.log(JSON.stringify({
  schema:snapshot.schema,configuredCount:snapshot.configuredCount,
  profile:snapshot.bootstrap.profile,
  bootstrapSha256:hash(snapshot.bootstrap.bytes),
  slots:snapshot.slots.map((slot,index)=>slot&&({
    letter:String.fromCharCode(65+index),instanceId:slot.instanceId,name:slot.name,
    bytes:slot.bytes.length,sha256:hash(slot.bytes),
    reservedSha256:hash(slot.bytes.subarray(0,16384))
  }))
}));
"""
    result = subprocess.run(
        ["node", "--input-type=module", "-e", code,
         (ROOT / "crates/triptych-host-wasm/web/saved-machine.js").as_uri(), str(archive)],
        cwd=ROOT, check=True, capture_output=True, text=True, timeout=30,
    )
    return json.loads(result.stdout)


def assert_retained(session, archive, archive_hash, metadata):
    assert digest(archive) == archive_hash, "source archive changed"
    assert digest(session / "original.tds") == archive_hash, "retained archive differs"
    assert digest(session / "bootstrap.bin") == metadata["bootstrapSha256"], "bootstrap changed"
    files = {"original.tds", "bootstrap.bin"}
    identities = set()
    for slot in metadata["slots"]:
        if slot is None:
            continue
        path = session / f"drive-{slot['letter']}.img"
        files.add(path.name)
        stat = path.stat()
        assert stat.st_size == slot["bytes"], f"wrong length: {path}"
        identities.add((stat.st_dev, stat.st_ino))
        assert digest(path) == slot["sha256"], f"saved image changed: {path}"
        with path.open("rb") as stream:
            reserved = hashlib.sha256(stream.read(16384)).hexdigest()
        assert reserved == slot["reservedSha256"], f"saved residents changed: {path}"
    assert len(identities) == sum(slot is not None for slot in metadata["slots"]), "aliased native images"
    assert {path.name for path in session.iterdir()} == files, "unexpected or missing session files"


def prove_case(name, host, archive, deployment, output, metadata, archive_hash,
               exit_method=None, command=None, sentinel=None, expected_code=0):
    master, slave = pty.openpty()
    report_read, report_write = os.pipe()
    process = None
    session = output / f"session-{name}"
    started = time.monotonic()
    log = (output / f"{name}.log").open("xb")
    captured = bytearray()

    def consume():
        data = os.read(master, 65536)
        captured.extend(data)
        log.write(data)
        log.flush()
        return data

    def wait_for(expected, timeout=30):
        response = bytearray()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                response.extend(consume())
                if expected in response:
                    return bytes(response)
            if process.poll() is not None:
                raise AssertionError(f"launcher exited {process.returncode}: {bytes(response)!r}")
        raise AssertionError(f"timed out waiting for {expected!r}: {bytes(response[-1000:])!r}")

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

        arguments = ["--archive", str(archive), "--deployment", str(deployment),
                     "--host", str(host), "--session", str(session)]
        process = subprocess.Popen(
            [sys.executable, str(Path(__file__).resolve()), "--supervisor", str(report_write), *arguments],
            cwd=ROOT, stdin=slave, stdout=slave, stderr=slave,
            preexec_fn=controlling_terminal, pass_fds=(report_write,),
        )
        os.close(report_write)
        report_write = None
        if exit_method:
            opening = wait_for(b"\r\nA>")
            assert b"configured slots: 16" in opening, opening
            active = termios.tcgetattr(slave)
            assert not active[0] & (termios.IXON | termios.IXOFF | termios.ICRNL), "input translation or flow control active"
            assert not active[1] & termios.OPOST, "output translation active"
            assert not active[3] & (termios.ICANON | termios.ECHO), "input buffering or echo active"
            assert active[3] & termios.ISIG, "Ctrl-C host exit disabled"
            os.write(master, command.encode("ascii") + b"\r")
            response = wait_for(b"\r\nA>")
            assert sentinel.encode("ascii") in response, response
            assert b"\r\r\r\n" not in response, "host added carriage returns"
            if exit_method == "ctrl-c":
                os.write(master, b"\x03")
            else:
                process.send_signal(signal.SIGTERM)
        deadline = time.monotonic() + 15
        while process.poll() is None and time.monotonic() < deadline:
            readable, _, _ = select.select([master], [], [], 0.1)
            if readable:
                consume()
        code = process.wait(timeout=1)
        while select.select([master], [], [], 0)[0]:
            if not consume():
                break
        assert code == expected_code, f"{name}: exit {code}, expected {expected_code}; {captured[-1000:]!r}"
        readable, _, _ = select.select([report_read], [], [], 2)
        assert readable, "supervisor did not report restored terminal state"
        restored = os.read(report_read, 16384).decode("ascii")
        assert restored == repr(saved), f"termios mismatch: {saved!r} != {restored}"
        assert_retained(session, archive, archive_hash, metadata)
        return {
            "case": name, "scope": "actual native CPU" if exit_method else "controlled executable lifecycle fixture; not CPU evidence",
            "exitCode": code, "termiosBefore": repr(saved), "termiosAfter": restored,
            "elapsedSeconds": time.monotonic() - started, "session": str(session),
            "log": str(output / f"{name}.log"), "exactArchiveAndImagesRetained": True,
            "command": command if exit_method else None,
            "sentinel": sentinel if exit_method else None,
        }
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=5)
        log.close()
        for fd in (master, slave, report_read, report_write):
            if fd is not None:
                os.close(fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for argument in ("archive", "deployment", "host", "output"):
        parser.add_argument(f"--{argument}", required=True, type=Path)
    parser.add_argument("--command", default="TYPE P:WHO.TXT")
    parser.add_argument("--sentinel", default="Drive P")
    args = parser.parse_args()
    archive, deployment, source_host = [value.resolve(strict=True) for value in (args.archive, args.deployment, args.host)]
    requested_output = args.output.absolute()
    output = requested_output.parent.resolve(strict=True) / requested_output.name
    if not source_host.is_file() or not os.access(source_host, os.X_OK):
        raise ValueError("--host must name an existing executable regular file")
    metadata = archive_metadata(archive)
    archive_hash = digest(archive)
    output.mkdir(mode=0o700)
    report = {
        "archive": str(archive), "archiveSha256": archive_hash,
        "deployment": str(deployment), "deploymentSha256": digest(deployment),
        "sourceHost": str(source_host), "sourceHostSha256": digest(source_host),
        "proofScriptSha256": digest(Path(__file__).resolve()),
        "launcherSha256": digest(LAUNCHER),
        "preparerSha256": digest(ROOT / "tools/lib/native-saved-machine.mjs"),
        "metadata": metadata, "cases": [], "complete": False,
        "sessionFiles": "retained raw recovery images, never checkpoint archives",
    }
    try:
        host = output / "frozen-native-host"
        with source_host.open("rb") as source, host.open("xb") as target:
            while chunk := source.read(1024 * 1024):
                target.write(chunk)
        host.chmod(0o500)
        assert digest(host) == report["sourceHostSha256"] == digest(source_host), "host changed during freeze"
        report["frozenHost"] = str(host)
        report["frozenHostSha256"] = digest(host)
        for method, code in (("ctrl-c", 130), ("sigterm", 143)):
            report["cases"].append(prove_case(
                method, host, archive, deployment, output, metadata, archive_hash,
                exit_method=method, command=args.command, sentinel=args.sentinel, expected_code=code,
            ))
        for name, script in (
            ("normal", "#!/bin/sh\nexit 0\n"),
            ("host-error", "#!/bin/sh\nexit 7\n"),
            ("failed-spawn", "#!/nonexistent-triptych-proof-interpreter\n"),
        ):
            fixture = output / f"fixture-{name}"
            with fixture.open("x") as stream:
                stream.write(script)
            fixture.chmod(0o700)
            report["cases"].append(prove_case(
                name, fixture, archive, deployment, output, metadata, archive_hash,
                expected_code=0 if name == "normal" else 1,
            ))
        assert digest(archive) == archive_hash, "source archive changed during proof"
        report["complete"] = True
        print(f"Saved native PTY proof passed: {len(report['cases'])} cases; evidence retained at {output}")
    except BaseException as error:
        report["error"] = repr(error)
        raise
    finally:
        with (output / "proof-report.json").open("x") as stream:
            json.dump(report, stream, indent=2)
            stream.write("\n")


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "--supervisor":
        sys.exit(supervisor(int(sys.argv[2]), sys.argv[3:]))
    main()
