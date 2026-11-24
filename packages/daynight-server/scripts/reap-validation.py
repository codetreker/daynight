#!/usr/bin/env python3
"""Run one Linux validation command with ownership of detached descendants."""

import ctypes
import errno
import os
import signal
import subprocess
import sys
import time


def main():
    if len(sys.argv) < 4:
        raise ValueError("Usage: reap-validation.py TIMEOUT_MS GRACE_MS COMMAND [ARGUMENT...]")
    timeout, grace = (int(value) for value in sys.argv[1:3])
    if timeout <= 0 or grace <= 0 or timeout > 2_147_483_647 or grace > 2_147_483_647:
        raise ValueError("Timeout and grace must be positive milliseconds within the timer range")
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        number = ctypes.get_errno()
        raise OSError(number, os.strerror(number))

    interrupted = None

    def interrupt(number, _frame):
        nonlocal interrupted
        if interrupted is None:
            interrupted = 128 + number

    signal.signal(signal.SIGTERM, interrupt)
    signal.signal(signal.SIGINT, interrupt)
    child = subprocess.Popen(sys.argv[3:], start_new_session=True)
    deadline = time.monotonic() + timeout / 1000
    primary = None
    cleanup_started = None
    force_deadline = None
    signalled = set()
    failed = False
    observed_children = f"/proc/self/task/{os.getpid()}/children"

    while True:
        no_children = False
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                no_children = True
                break
            if pid == 0:
                break
            signalled.discard(pid)
            if pid == child.pid:
                primary = os.waitstatus_to_exitcode(status)
                child.returncode = primary

        now = time.monotonic()
        if cleanup_started is None and interrupted is None and now >= deadline:
            interrupted = 124
            print(f"Validation command exceeded {timeout}ms: {sys.argv[3]}", file=sys.stderr, flush=True)
        if cleanup_started is None and (interrupted is not None or primary is not None):
            cleanup_started = now
            force_deadline = now + grace / 1000 + 10
            # The original group gets a graceful shutdown while its leader's
            # identity is still held; detached descendants are adopted below.
            if interrupted is not None and primary is None:
                try:
                    os.killpg(child.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    failed = True
                    print(f"Unable to signal validation group: {error}", file=sys.stderr, flush=True)

        if no_children:
            if primary is None:
                raise RuntimeError("Validation leader disappeared without a wait status")
            if failed:
                return 125
            return interrupted if interrupted is not None else (primary if primary >= 0 else 128 - primary)

        if cleanup_started is not None:
            forced = now >= cleanup_started + grace / 1000
            try:
                with open(observed_children, encoding="ascii") as listing:
                    children = [int(value) for value in listing.read().split()]
            except (OSError, ValueError) as error:
                failed = True
                print(f"Unable to observe validation descendants: {error}", file=sys.stderr, flush=True)
                children = []
            for pid in children:
                if not forced and pid in signalled:
                    continue
                try:
                    # A live direct child cannot reuse its PID until this process
                    # reaps it; only this single thread calls waitpid.
                    os.kill(pid, signal.SIGKILL if forced else signal.SIGTERM)
                    signalled.add(pid)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    failed = True
                    print(f"Unable to signal validation descendant {pid}: {error}", file=sys.stderr, flush=True)
            if now >= force_deadline:
                print("Unable to reap all validation descendants before the cleanup deadline", file=sys.stderr, flush=True)
                return 125
        time.sleep(0.02)


try:
    sys.exit(main())
except (OSError, ValueError, RuntimeError) as error:
    print(f"Validation supervisor failed: {error}", file=sys.stderr, flush=True)
    sys.exit(125)
