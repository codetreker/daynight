# Agent Note: Windows Worktree Process Cleanup

Status: implemented

## Problem

Windows keeps a directory handle open for every process working directory. The
[busy removal retry](../bug-fix/2026-11-20-windows-busy-worktree-removal.md)
covers the window in which a terminated agent's handle has not been reclaimed
yet, and states plainly that a directory held by a *live* process still fails
with its original `EBUSY`. That case is now recoverable.

It is not hypothetical. Three directories left behind by a test run on a
development machine stayed `EBUSY` for hours, long after the run had finished,
and `Directory.Delete` reported them as "being used by another process".

## Decision

When ordinary removal exhausts its busy retries and still fails with `EBUSY`,
and the applied `enableWindowsProcessCleanup` target is true, cleanup lists the
processes whose working directory lies inside the verified worktree, terminates
each one with its descendants, and runs the same removal sequence again.

The option exists because that termination reaches processes the Worker never
launched: `taskkill /T` also terminates the processes it can attribute to the
holder as children, and a holder may itself be something an agent spawned and
abandoned. That is an operator decision, not a default, which is also why it is
a target of its own rather than a platform branch of `enableSudoCleanup`:
privileged deletion of files the Worker owns and termination of processes it
does not own authorize different things.

`/T` is not a guarantee that every descendant dies. A grandchild whose parent
has already exited may no longer be attributable to the holder and can survive.
That is not a correctness problem here: a survivor that still holds the
directory leaves the retry failing with the same `EBUSY`, which is preserved
together with cleanup responsibility, exactly as when no holder was reportable
at all.

### Finding the holders

`windowsDirectoryHolders` enumerates processes with `CreateToolhelp32Snapshot`,
then reads each one's working directory from its `RTL_USER_PROCESS_PARAMETERS`
through `NtQueryInformationProcess` and `ReadProcessMemory`. A process it
cannot open or read is skipped rather than failing the inventory: another
account's process is not a holder this Worker can act on. The layout offsets are
refused outright on an unexpected pointer size rather than guessed, because a
wrong offset reads an unrelated address and could name a directory belonging to
no process.

The Worker's own pointer size does not describe the process being inspected. A
64-bit Worker can read a 32-bit WOW64 holder, whose running code maintains its
32-bit process parameters; the native structures reached through
`ProcessBasicInformation` do not carry that process's active working directory.
`ProcessWow64Information` yields the 32-bit PEB for such a process and zero for
a native one, which is what selects the layout. Reading the native structures
for both would silently omit a 32-bit holder and leave cleanup refusing to
remove a directory it was authorized to recover.

Each holder's process handle stays open from inspection until termination.
Windows does not recycle a process identifier while a handle to that process
remains open, so holding it is what makes the identifier safe to pass to
`taskkill`. Comparing creation times afterwards would not close that window: by
then the identifier could already name a different process.

The inventory reports neither this process nor its ancestors. Excluding only
this process looks sufficient and is not: `taskkill /T` ends the descendants of
what it is given, so terminating any ancestor ends this cleanup with it. That
happens partway through a removal, leaving no error to report and the worktree
in whatever state it had reached — the one failure here that produces no
diagnostic at all. A Worker started from a shell whose working directory is
inside the worktree has exactly that ancestor.

The walk follows the parent each process records in the Toolhelp snapshot.
Windows reuses a parent identifier once that parent has exited, so the chain
can stop early or close on itself; the walk ends on a repeat, and being wrong
in either direction only declines a termination.

An injected kernel cannot prove the offset that parent is read from. A wrong
one fails silently in the worst direction: the walk finds nothing, the guard
disappears, and every synthetic test still passes. A test therefore reads the
real process table and checks it against the two parents Node already knows —
this process's `ppid`, and a child it just spawned. Pointing the offset at the
neighbouring field makes it report 17 instead of the real identifier.

Releasing those handles cannot replace the error that ended the termination.
A throw from a `finally` discards whatever was already on its way out, so a
cancellation or deadline would reach the caller as a handle failure instead —
and the attempt-level record depends on the cancellation still being
recognizable. The release is therefore aggregated with the original, which the
content walk already does for its directory handles.

### Keeping ownership proven

Ownership is verified before the inventory decides which processes to act on,
and again before the retry mutates anything. Termination is asynchronous, so
the directory this cleanup proved it owns must still be the one it removes.

The first attempt and the retry run one `removeOwnedWorktree` sequence, so the
two cannot verify different things. The Git pointer is unlinked only once: a
retry that already reached the root has removed it, and `verifyOwnership`
switches to requiring its absence at that point.

### Reaching the recovery after an interrupted attempt

Ordinary cleanup unlinks the Git pointer before it removes the root, so an
attempt that fails at the root leaves the worktree registered, empty and
pointerless. Every later attempt then enters the branch for a registered
worktree whose pointer an interrupted cleanup already removed, not the main
path. That branch recovers holders too; without it one busy failure would
permanently route every subsequent attempt away from the recovery, including
after a Worker restart and including the case where the target was enabled only
after an earlier cleanup had already failed with it disabled.

It does not reuse that branch's existing verifier. Those checks — the leaf
identity, the still absent pointer and the registration lock — are enough for a
nonrecursive removal of a directory whose inode already matched: the worst
outcome is removing the very directory that was proven. Terminating processes
is irreversible, reaches descendants, and acts on something other than the
directory, so it is admitted through the evidence the main path proves: the
owner manifest, the captured ownership-directory identities, and the
registration's `gitdir` and `commondir` association, each rechecked after those
asynchronous reads. A manifest removed or a registration retargeted during the
backoff therefore refuses before any holder is inspected, and the original
error is retained.

The captured evidence is itself proven before anything relies on it. The
inspection that produced the result resolved the registration before those
reads, so an association retargeted in between would be captured as the
baseline and then agree with itself on every later comparison. A fresh
inspection must match the one already held, and the captured metadata must
still read the same, before the capture is trusted.

On the main path the admission is `verifyOwnedRoot` rather than
`verifyOwnership`. The weaker one checks the directory identities before it
awaits the pointer, metadata and lock reads. Once the busy holder exits, the
now empty root can be replaced during those reads and a holder started inside
the replacement; with the pointer already gone, an empty replacement satisfies
every remaining check. Terminating that unrelated process tree cannot be undone
by the identity failure that follows, so the recovery uses the verifier that
rechecks the identities after the reads, as ordinary root removal already does.

### Every busy removal, not only the registered worktree

Cleanup removes three managed directories, and all three can be held: the
worktree contents, the worktree root, and an unregistered reservation left
when a task path has a directory but no Git registration. The first two are
one sequence and share the main recovery. The reservation is reached through
its own path and had none, so an operator who enabled the target would still
have seen cleanup stop there.

It is admitted through its existing verifier, which already rechecks the
reservation identities after its asynchronous registration scan and is
therefore the strong form this action needs. The inaccessible-worktree branch
is deliberately not included: it recovers permission obstacles, which this
target does not authorize.

### Why the trigger is EBUSY, and what would silently remove it

The recovery is reached only from an EBUSY failure, and that code is not a
property of the obstacle. It is a property of the call. Measured on Windows
against a directory held as a live process's working directory:

| Removal | Result |
|---|---|
| `rmdir` of the held directory | `EBUSY` |
| recursive `rm` of the held directory | `EPERM` |
| recursive `rm` of any ancestor | `EPERM` |

The content walk and the empty-directory removal both use nonrecursive
`rmdir`, so the obstacle arrives as EBUSY and the recovery sees it. A refactor
to recursive removal would report EPERM instead, which the walk converts into
a permission error — routing a held worktree to the sudo path, where
elevation cannot help, and leaving the holders running. Nothing in the types
prevents that change, so an end-to-end test pins it: it drives the real walk
against a real holder and asserts the code is EBUSY before terminating
anything.

## Alternatives

**Use the Restart Manager to find the holders.** `RmStartSession`,
`RmRegisterResources` and `RmGetList` report the processes holding a resource
without elevation, which is how installers identify what to close. Measurement
rejects it for this purpose: against a file held open it works, returning
`ERROR_MORE_DATA` and then the holder's identifier, creation time and
application name. Against a *directory* held as a process working directory —
one that `rmdir` genuinely refuses with `EBUSY` — `RmGetList` returns
`ERROR_ACCESS_DENIED` with no holders. Restart Manager registers file
resources; the directory handle behind this failure is not one.

**Match the holder by its command line.** Cheaper than reading process memory
and needs no interop. It finds nothing: the three stuck directories named above
appear only in their holders' working directories, never in the command lines,
so a command-line scan reports no holder for a directory that three live
processes were holding.

**Terminate the execution process tree the Worker launched.** The Worker
already persists a `ProcessProof` with birth evidence, and on Windows a job
object that would take the tree atomically, so this needs no interop at all.
It addresses the wrong set: cleanup runs after the execution is stopped, and
the holders observed in practice were orphans that were not the agent tree.
Threading that evidence from the execution layer into cleanup would also be a
wider change than discovering holders where they are.

**Retry for longer instead of terminating.** The existing backoff already
covers handle release after exit. A live holder does not exit because the
remover waited; the measured directories were still held hours later.

**Terminate every reported holder regardless of location.** The inventory is
filtered to the worktree subtree on a separator boundary, so a sibling path
that merely shares a prefix is not a holder. Acting on anything outside the
directory whose ownership was proven would make the option unbounded.

## Consequences

Cleanup recovers a worktree held by a live process on Windows when the operator
has enabled it, at the cost of terminating that process and the processes
attributable to it as children.
The target defaults to false and nothing happens without it, so existing
deployments are unchanged.

Only working-directory holders are recovered. A process that keeps an open file
inside the tree also blocks removal and is not reported, so the retry observes
the same obstacle and the original `EBUSY` is preserved together with cleanup
responsibility. The same is true when every holder belongs to another account.

A failed attempt names the holders it already ended. Termination cannot be
undone and the processes it ends may be ones the Worker never started, so when
the attempt fails the diagnostic is the only record the operator receives that
any of it happened; a failure that mentioned only the revision would read as
though nothing had been touched. Holders that survived are not claimed as
ended, and a termination that reached nothing says so.

The record belongs to the attempt, not to the recovery that performs the
terminations. Reading it from the recovery's return value loses it three ways:
the terminations accumulated before cancellation or the deadline are discarded
with the throw that ends the loop, the postcondition observation and the
completeness check both fail after the holders are gone, and an absent
worktree reported with an effect error never throws at all. Each holder is
therefore recorded the moment it is terminated, through a sink the attempt
owns, and one wrap at the attempt boundary carries that record onto every
exit. The recovery's own failure says only that it ended nothing, so the two
never repeat each other. A nested reservation cleanup shares the array, so one
attempt reports all of its terminations together.

The record is not exact in one direction. A holder that exited on its own just
before its termination is listed as ended, because `taskkill` reports the same
absence either way and distinguishing them would mean asking about liveness
the inventory has no reason to track. That errs toward naming a process the
Worker did not end rather than omitting one it did, which is the direction an
irreversible action should be wrong in.

A recovery that succeeds has no failure to carry that record, and it has still
ended processes the Worker may never have started. Each termination is
therefore also reported as it happens, through the same kind of reporter the
Git manager already uses for pending and settled cleanup. The Worker event
this produces needs no new type: `WorkerEvent` carries an open `kind`, so the
local diagnostics channel absorbs it without touching the protocol the service
reads.

Its failures do not change the outcome of the cleanup they describe. That
departs from the Git reporters, whose failures are aggregated into the cleanup
error, and the reason is that this one runs inside the per-holder guard of the
termination loop: a throw there would be collected as a holder that could not
be terminated, inverting the record it exists to keep. Swallowing is not
silent either — the diagnostics sink reports its own unavailability, so a
broken channel surfaces where it belongs rather than as a worktree that failed
to clean up for no reason the operator can act on.

`WorkerCleanupPolicy` now carries each member's own committed revision rather
than one shared value. Both members are read from their own application result,
and a diagnostic names the revision of the member that authorized the action
rather than a revision that may belong to the other one.
