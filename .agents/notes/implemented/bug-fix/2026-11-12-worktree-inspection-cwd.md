# Agent Note: Inspect worktrees from a stable Git cwd

Status: implemented

## Problem

Resource inventory can inspect an owned worktree while its cleanup job removes
that directory. On Windows, a running process locks its current directory against
deletion, movement and renaming, as documented by
[SetCurrentDirectory](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setcurrentdirectory).
Starting read-only Git metadata queries in that leaf can therefore obstruct the
Worker's own deletion. A [Windows removal failure](https://github.com/codetreker/daynight/actions/runs/43312784785/job/131513061419)
reached rmdir before the Git mutation started; its locking PID was not recorded.

## Decision

After the existing manifest, filesystem, registration, common-directory and
pointer checks, the two worktree metadata queries run from the stable primary
repository root. Each receives both the verified absolute administrative
`--git-dir` and the manifest-bound absolute leaf as `--work-tree`. The queries are
`rev-parse --path-format=absolute --git-common-dir` and
`config --get-all remote.origin.url`; relative output is interpreted from the
actual runner cwd. They retain the existing bounded read-only runner, operation
cancellation and absolute deadline.

Git interprets the linked worktree's configuration, including `config.worktree`
and supported `includeIf worktree/onbranch` conditions. The explicit worktree
preserves the manifest leaf as physical authority; a `core.worktree` redirect
cannot adopt another directory. In the inspected
[Git for Windows setup implementation](https://github.com/git-for-windows/git/blob/581291682ad5a238c08c93d1f5bd4518382a3230/setup.c#L1219-L1273),
an explicit absolute worktree avoids resolving relative `core.worktree` by
changing directories, and a cwd outside that worktree avoids entering it during
repository setup. These metadata queries do not require worktree setup.

The [manifest adoption decision](../architecture/2026-11-12-worktree-manifest-adoption.md)
still owns resource identity, allocation and retirement. Branch, origin, lock,
registration and pointer checks retain their original rejection and unknown
results. Git mutations retain their separate
[local-closure responsibility](../architecture/2026-11-11-worker-git-mutation-closure.md).
The [Worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份)
owns the complete current mechanism.

## Alternatives

**Keep the leaf as cwd or use `-C <leaf>`.** Both enter the directory being removed
and retain the Windows cwd lock that causes self-interference.

**Pass only `--git-dir`.** Worktree-dependent configuration would no longer have
an explicit manifest-bound context, and relative `core.worktree` can cause Git
setup to change directories.

**Delay cleanup or retry the removal.** Scheduling changes do not eliminate the
query's directory lock and can retain resources after an avoidable failure.

## Consequences

Concurrent inspection no longer holds the leaf through its process cwd. Actual
filesystem and Git errors remain visible, and cleanup retains its existing
resource, deadline and backoff obligations. This routing is limited to the two
metadata queries; it does not authorize arbitrary Git commands or weaken
physical ownership checks. It does not identify the unrecorded holder in the
original failure, establish escaped-descendant stopping, or isolate concurrent
malicious filesystem replacement. Native Windows tests own proof of concurrent
reader lifetime and leaf deletion; other platforms' successful reads cannot
establish Windows deletion behavior.
