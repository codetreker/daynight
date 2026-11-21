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

`retryWhileBusy` reattempts a removal that fails with `EBUSY`, waiting 20, 40,
80, 160 and 320 milliseconds between attempts. Any other error code propagates
on the first failure, so `EACCES` and `EPERM` still become a
`WorktreePermissionError` and reach the existing privileged recovery unchanged.

Each delay is a window in which another writer can replace the target, so the
caller supplies a `reprove` callback that runs after every delay. It re-verifies
the same ownership evidence the caller established before its first attempt and
re-admits the mutation; a changed identity aborts instead of deleting whatever
now occupies the path. `operation.check()` runs around each delay and again after `reprove`
returns: a verifier ends in asynchronous reads, so cancellation and the
deadline can arrive while it awaits, and checking at the shared boundary stops
the next attempt without depending on each verifier to end with a check of its
own. Identity verification does not cover either condition.

`reprove` is a required parameter rather than an optional one. A default no-op
would silently weaken any caller that forgot it: before this change a first
`EBUSY` ended the removal, so an omitted callback would newly allow five
unverified attempts. Requiring it makes every call site state its own evidence,
and the compiler rejects a new caller that has none.

Every removal site supplies one. Inside `removeWorktreeContents`, entry removal
reproves the parent directory and the entry's own inode and type, and nested
directory removal reproves the directory. Those checks prove local identity
only, so the task worktree caller also passes `verifyOwnership` as
`beforeMutation`: the walk admits every mutation, first attempt and retry
alike, through the same manifest, captured metadata and external Git lock the
caller verified before the walk began. Without it a lock taken during a busy
backoff would go unseen until after the contents were already gone, because
the walk itself rechecks nothing outside the directory it is clearing.
Outside the content walk,
`removeEmptyDirectory` in `worktrees.ts` removes the task worktree root, the
directory the agent's own working directory holds. It passes `verifyOwnedRoot`,
which runs `verifyOwnership` and then rechecks the captured directory
identities: `verifyOwnership` establishes those identities before it reads the
pointer, metadata and lock, and those reads are asynchronous, so the root can be
replaced while they run. The recovery branch for a registered worktree whose pointer an interrupted
cleanup already removed verifies the leaf identity, the still absent pointer and
the registration's `locked` marker: Git records an external lock on the
registration rather than on the pointerless directory, so the inspection that
follows removal would observe it only once the directory was gone.
`removeEmptyReservation` verifies its reservation through a
single function that the first attempt and every retry both call, so the two
cannot diverge. That function checks its captured directory identities,
including the reservation leaf, confirms no Git registration appeared, and
checks the identities again afterwards: the registration scan is asynchronous,
so a reservation replaced while it runs would otherwise leave the scan
reporting on a directory the removal no longer owns.

The retry is not platform-guarded. `EBUSY` is diagnostic on its own and a single
code path keeps the behavior covered by tests on every platform.

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

**Retry without reproving ownership.** Relying on `operation.check()` alone is
cheaper and was the first implementation, but that call tests cancellation and
the deadline, not identity. An entry replaced during the backoff would then be
deleted in place of the one whose ownership was proven, turning a cleanup
failure into deletion of an unrelated file.

**Retry only inside the content walk.** This covers nested entries but leaves
out the worktree root, which `visit(target, root, true)` deliberately preserves
and `removeEmptyDirectory` removes afterwards. The root is the agent's own
working directory and therefore the single path most likely to be busy, so
omitting it would have left the original failure in place.

**Reprove the external Git lock only on the retry path.** This would keep the
content walk's per-entry cost unchanged, but it recreates the divergence the
required `reprove` parameter exists to prevent: the first attempt and the
retries would admit mutations through different evidence. Passing
`verifyOwnership` as `beforeMutation` instead strengthens both at once, at the
cost of one manifest lookup, the captured directory and metadata reads and one
lock read per removed entry.

**Add the missing check to each retry callback as it is found.** Three separate
findings had the same shape: a first attempt verified ownership around an
asynchronous read, and the retry path repeated only part of it. Patching each
callback in turn leaves the two paths free to drift again. Each caller now
verifies through one function that its first attempt and every retry both call,
so a future check added to one is necessarily applied to the other.

**Default `reprove` to a no-op for callers without evidence.** This keeps the
signature smaller, but it converts an omission into a silent weakening: the
reservation cleanup path would have retried five times on a directory it never
reverified, where a single `EBUSY` previously stopped it. A required parameter
turns that omission into a compile error.

## Consequences

Cleanup now succeeds across the handle-release window that follows a terminated
agent, at both the nested entries and the worktree root, at a cost of at most
620 milliseconds of added latency per busy removal and none on the succeeding
path. A directory held by a live process still fails, with its original `EBUSY`
preserved for diagnosis and its Git registration retained; recovering that case
requires the separate termination option described above. Ownership guarantees
are unchanged: every attempt acts only on a target whose identity was proven
immediately beforehand.
