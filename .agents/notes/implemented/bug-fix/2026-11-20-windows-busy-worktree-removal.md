# Agent Note: Windows Busy Worktree Removal

Status: implemented

## Problem

Windows binds a directory handle to every process working directory and releases
it only after that process fully exits. Worker cleanup runs immediately after it
terminates an agent, so `rmdir` and `unlink` observe `EBUSY` on a directory that
no live process still owns. The holder is gone; only its handle has not been
reclaimed yet.

POSIX has no equivalent: a directory that serves as a working directory unlinks
normally, so this failure never appeared on Linux or macOS. The existing
[sudo cleanup](../feature/2026-11-17-worker-sudo-cleanup.md) recovery does not
cover it either, because that path matches `EACCES` and `EPERM` and is skipped
entirely when `process.platform === "win32"`. A Windows worker therefore fails
the whole cleanup and leaves the worktree behind, and retrying the task hits the
same window again.

## Decision

`removeWorktreeContents` retries an entry or directory removal that fails with
`EBUSY`, waiting 20, 40, 80, 160 and 320 milliseconds between attempts. Any
other error code propagates on the first failure, so `EACCES` and `EPERM` still
become a `WorktreePermissionError` and reach the existing privileged recovery
unchanged. The retry calls `operation.check()` before and after each delay, so
cancellation and deadline stop it without starting another mutation.

The retry is not platform-guarded. `EBUSY` is diagnostic on its own, the
surrounding identity verification is unchanged, and a single code path keeps the
behavior covered by tests on every platform.

## Alternatives

**Rename the directory aside and remove it later.** Measurement rejects this:
Windows returns `EPERM` when renaming a directory that is a process working
directory, and `EBUSY` when renaming its parent. The directory cannot be moved
out of the way any more than it can be deleted, so the technique that works for
locked files does not apply here.

**Guard the retry behind `process.platform === "win32"`.** POSIX removal reports
`EBUSY` only for mount points, which `assertNoWorktreeMounts` already rejects
earlier, so the guard would exclude no real failure. It would instead leave the
retry uncovered by Linux and macOS test runs, where most validation happens.

**Extend privileged cleanup to Windows.** Elevation does not release another
process's working-directory handle, so it cannot recover this failure. Windows
also has no silent equivalent of `sudo -n`: elevation either raises a UAC prompt,
which blocks an unattended worker indefinitely, or requires a resident
high-privilege service.

**Terminate the process tree that holds the directory.** This recovers the case
where the holder is still alive, which retrying cannot. It also terminates
processes the worker does not own, so it needs explicit operator consent rather
than being unconditional, and belongs to its own configuration option.

## Consequences

Cleanup now succeeds across the handle-release window that follows a terminated
agent, at a cost of at most 620 milliseconds of added latency on the failing
path and none on the succeeding one. A directory held by a live process still
fails, with its original `EBUSY` error preserved for diagnosis; recovering that
case requires the separate termination option described above. The retry adds no
new permission or ownership assumption, because every identity check around the
removal is unchanged.
