# Agent Note: Refresh Worker Branch Bases from the Remote Default

Status: implemented

## Problem

A newly claimed task needs a current starting point, but an existing repository's
checkout can lag the remote default branch or point at an unrelated branch. A
local remote-tracking default can also be stale. Creating a task branch from
these local refs can start work from an unintended commit, while recovery must
preserve retained branches and uncommitted task work.

## Decision

After checking for an existing owned worktree and retained task branch, the
[Worker Git manager](../../../../packages/daynight/src/commands/worker/worktrees.ts)
fetches origin's remote HEAD to a private ref bound to the worktree ID. It
resolves a commit and passes that fixed SHA to worktree creation, including after
an initial clone. The controlled fetch avoids FETCH_HEAD, additional ref
mappings, tags, submodule recursion and automatic maintenance. On successful
creation it compare-and-deletes the temporary ref using the resolved SHA;
later attempts for the same worktree ID may overwrite and recover an abandoned
ref. Fetch and resolution failures, cancellation and timeout prevent new branch
creation, and cleanup errors remain visible without hiding creation errors.

Owned worktrees and retained task branches remain usable without a network
refresh. The checkout and local mainline are not updated by this operation. The
[Worker requirements](../../../../docs/spec/daynight-worker.md#w-06稳定的-task-worktree)
and [design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份)
own the resulting behavior and mechanism. This replaces the initial repository
HEAD baseline in the archived [stable workspace decision](../../archived/architecture/2026-10-26-worker-git-workspaces.md),
whose ownership and recovery rationale remains applicable.

## Alternatives

**Use local HEAD or origin/HEAD.** Either can be stale, and HEAD can refer to an
unrelated checked-out branch. Neither proves which commit the remote currently
advertises as its default.

**Use shared FETCH_HEAD as the baseline.** Concurrent tasks in one repository
can overwrite that shared observation between fetch and worktree creation. A
worktree-specific ref and fixed SHA isolate their results.

## Consequences

New task branches require a reachable origin with a usable default commit; a
failure is visible instead of silently creating from an outdated local baseline.
Fetching adds network work to initial creation, while retained work stays
available offline. Interrupted operations can leave a private ref until another
attempt for the same worktree ID reclaims it; it does not authorize reuse of a
stale baseline. Different tasks retain their existing concurrency and same-task
serialization rules.
