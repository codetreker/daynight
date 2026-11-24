# Agent Note: Discover Worker worktrees from Git registrations

Status: implemented

## Problem

The Worker must recognize task worktrees after a restart and avoid reusing one
while its original execution is still outstanding. A worktree directory and its
Git registration can both disappear while separate ownership metadata
survives. That metadata can then block scheduling without a Git resource to
clean up, particularly after the Worker or Controller state is cleared.

## Decision

A Git registration identifies a task worktree when it names a direct child of
the repository's `.worktrees/daynight/` directory and its branch is
`refs/heads/daynight/<task-id>`. The Worker creates its worktrees without Git
worktree locks. An execution's original claim and Web execution binding identify
the particular checkout used by that execution. That binding and original
lifecycle records still govern operations that require the exact original
execution or proof of stop.

The Worker verifies both the checkout and its Git registration when observing
file cleanup. A registration can remain after the checkout disappears. An old
manifest does not participate in discovery, acquisition, or cleanup. See the
[Worker design](../../../../docs/design/daynight-worker.md#git-工作区与资源身份)
for inspection and cleanup.

This supersedes [manifest storage](../architecture/2026-11-11-worktree-manifest-storage.md),
[manifest adoption](../architecture/2026-11-12-worktree-manifest-adoption.md),
[format conversion](../architecture/2026-11-11-worktree-resource-migration.md),
and the [Web-specific migration](../architecture/2026-11-17-web-worktree-migration.md).

## Alternatives

**Keep repository-local manifests.** The previous design could retain a
claim-to-path map across partial Git operations. With a dedicated directory and
task-specific branches, Git already provides task discovery. A second store
requires its own retirement and can leave an orphan that blocks a task after its
resources are gone.

**Store task ownership in a Git worktree lock.** The path and branch already
identify the task. A lock introduces a separate lifecycle dependency and can
prevent Git from cleaning a stale registration.

## Consequences

The repository has one current source for Git worktree discovery. A real Git
registration that cannot be matched to independent execution evidence still
reserves the task. Process and archive responsibilities are resolved with the
original execution evidence, independently of the presence of the checkout.
An existing Git worktree lock continues to protect its registration. An older
CLI that requires manifests cannot manage a checkout created by this Worker.
