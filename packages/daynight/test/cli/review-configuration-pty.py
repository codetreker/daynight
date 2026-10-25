"""Drive the installed CLI with terminal input and stderr, and piped stdout."""

import errno
import fcntl
import json
import os
import pty
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import termios
import time


def main():
    specification = json.load(sys.stdin)
    master, slave = pty.openpty()

    def terminal_session():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    process = subprocess.Popen(
        specification["command"],
        cwd=specification["cwd"],
        env=specification["environment"],
        stdin=slave,
        stdout=subprocess.PIPE,
        stderr=slave if specification.get("stderrTerminal", True) else subprocess.PIPE,
        preexec_fn=terminal_session,
        close_fds=True,
    )
    os.close(slave)
    streams = selectors.DefaultSelector()
    streams.register(master, selectors.EVENT_READ, "stderr")
    streams.register(process.stdout, selectors.EVENT_READ, "stdout")
    if process.stderr is not None:
        streams.register(process.stderr, selectors.EVENT_READ, "stderr")
    captured = {"stdout": bytearray(), "stderr": bytearray()}
    actions = specification.get("actions", [])
    action_index = 0
    deadline = time.monotonic() + 10
    try:
        while streams.get_map():
            if time.monotonic() >= deadline:
                raise TimeoutError("Terminal command exceeded ten seconds: " + captured["stderr"].decode(errors="replace"))
            for key, _ in streams.select(0.05):
                try:
                    chunk = os.read(key.fd, 65536)
                except OSError as cause:
                    if cause.errno != errno.EIO:
                        raise
                    chunk = b""
                if chunk:
                    captured[key.data].extend(chunk)
                else:
                    streams.unregister(key.fileobj)
            while action_index < len(actions):
                action = actions[action_index]
                if action["waitFor"] not in captured["stderr"].decode(errors="replace"):
                    break
                if "write" in action:
                    Path(action["write"]["file"]).write_text(action["write"]["contents"])
                if "input" in action:
                    os.write(master, action["input"].encode())
                else:
                    os.killpg(process.pid, getattr(signal, action["signal"]))
                action_index += 1
            if process.poll() is not None and not streams.get_map():
                break
        code = process.wait(timeout=1)
        if action_index != len(actions):
            raise RuntimeError("Command exited before terminal action " + str(action_index) + ": " + captured["stderr"].decode(errors="replace"))
        print(json.dumps({"code": code, **{name: content.decode(errors="replace") for name, content in captured.items()}}))
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=2)
        streams.close()
        process.stdout.close()
        if process.stderr is not None:
            process.stderr.close()
        os.close(master)


if __name__ == "__main__":
    main()
