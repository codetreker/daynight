# Agent Note: Owned read-only directory cleanup

Status: implemented

## Problem

Go module caches contain directories with mode 0555 and files with mode 0444.
Removing a directory entry requires write permission on its parent. Recursive
`fs.rm` therefore leaves an otherwise attributable terminal worktree behind on
POSIX systems, retaining its worker slot and preventing a later claim for the
same task from starting. Changing file permissions does not address that cause.
Recovery must preserve the evidence that authorizes deletion and must not change
external symlink targets or hard-linked file inodes.

Resource discovery can also return a snapshot taken before an overlapping
cleanup finished. Re-entering Web cleanup with its now-completed record rejects
the mutation and can retain the final slot indefinitely despite successful
physical removal.

Testing an in-flight deadline requires expiring the deadline after the controlled
filesystem mutation has entered. A real 30-millisecond deadline armed before
ownership and directory checks can expire during those checks, leaving the
intended join behavior untested.

## Decision

The [worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份)
owns the deletion mechanism. After complete worktree ownership verification,
the worker removes entries individually and retains the top-level `.git` pointer
until all other content is gone. It preserves the task branch and Git history.

On POSIX, the walker opens each directory without following its final symlink,
compares the path and descriptor identities, and requires the current effective
user, the worktree device, and existing owner read/search permissions. Only a
missing owner write bit is added through the verified directory descriptor.
Files and links are unlinked without an application permission fallback. Ancestor identity
and ownership metadata are checked before mutations; observed replacements and
I/O errors stop cleanup and retain the remaining evidence.

Cancellation joins submitted filesystem operations and descriptor closes. An
in-process guard rejects overlapping removals for the same physical repository
and task until the original call settles. This supplements the coordinator's
existing task serialization; it does not replace the worker instance lock.

The in-flight deadline test controls both the timeout queue and the imported
Node monotonic clock. It waits for the removal-entry barrier with time paused,
then advances both clocks by the original 30 milliseconds. Filesystem operations
and immediate callbacks remain real, preserving the proof that an admitted
mutation settles before rejection and no later mutation starts. The operation
is disposed before the clocks and spies are restored.

The original completed-Web fix reused stored stop/closure/deletion evidence and
rechecked Git absence to settle an overlapping snapshot. The
[resource-state decision](../architecture/2026-11-04-worker-resource-state.md)
supersedes that reuse: repeated cleanup obtains fresh Controller, OS, endpoint
and Git observations even for a done record. Remaining attributable resources
are reconciled toward absence; replaced or unreadable resources remain visible
errors. The done record cannot stand in for resource state.

## Alternatives

**Recursive chmod followed by recursive rm.** Path-based chmod can follow a
replacement symlink or change a hard-linked file outside the worktree. A separate
permission pass also leaves recursive deletion without per-entry identity or
cancellation checks.

**Retry unchanged recursive rm.** The directory permission is persistent; retries
cannot remove its entries and would keep the slot occupied indefinitely.

**Discard completed resources from an old snapshot by status alone.** A completed
record cannot prove that the path is still absent. Rechecking actual Git ownership
avoids hiding a reappearing worktree or releasing capacity on an unreadable path.

**Native descriptor-relative traversal.** openat/unlinkat could provide stronger
protection against concurrent ancestor replacement. Node does not expose a
portable equivalent, and introducing a native runtime dependency is unnecessary
for the stopped-process cleanup contract. The descriptor-bound chmod and checked
path traversal retain the explicit concurrency limitation below.

## Consequences

Nested read-only module directories can be cleaned without modifying shared
caches or POSIX ordinary-file permissions. Unknown ownership, foreign uid/device,
inaccessible directories, and filesystem failures remain visible failures.
Windows retains checked ordinary-directory traversal without POSIX permission
repair. It does not acquire a file-permission fallback through `fs.rm`; Windows
unlink behavior still depends on libuv and the underlying filesystem, so this
does not establish preservation of Windows read-only attributes on every volume.

Additional filesystem checks cost work per entry and per retained ancestor;
handles remain open along the current traversal depth. The walker yields at
awaited operations, allowing unrelated tasks to progress. A cancellation waits
for a pending syscall to finish; it cannot force an unresponsive filesystem to
return while safely allowing another deletion to start.

The existing stopped-agent and closed-workspace prerequisites remain necessary.
Path-based unlink/rmdir cannot atomically exclude an external process that
replaces ancestors after the final identity check. This is not a filesystem
sandbox against hostile concurrent writers. Descriptor chmod cannot be redirected
to a replacement path. Failures after the final `.git` unlink can leave an empty
leaf. The resource-state decision removes that residue with checked nonrecursive
rmdir while preserving the original refusal to delete unknown nonempty contents.

Archive success, stopped-process proof, worktree removal, slot release, and
shutdown behavior retain their separate responsibilities. This fix changes
neither service protocol nor scheduling policy.
