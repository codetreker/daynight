# Agent Note: Repository-Local Review Worktrees

Status: implemented

## Problem

Review worktrees are disposable checkouts of a specific local repository. Their
location should follow that repository's worktree convention while retained
review history and sessions remain independent of checkout cleanup.

## Decision

The [owned-worktree implementation](2026-10-17-owned-review-worktrees.md) applies
this layout with session-labelled Git locks and physical ownership checks. The
[foreground coordinator](2026-10-17-foreground-review-coordination.md) connects it
to polling and retained Copilot execution.

The [requirements](../../../../docs/spec/daynight-review.md) and
[design](../../../../docs/design/daynight-review.md) place PR worktrees under each
configured repository root's `.worktrees/` directory. The proposed stable path is
`<repository>/.worktrees/pr-<number>/`. SQLite records ownership, and the CLI only
prepares or removes its registered worktrees. Other PR worktrees remain
independent. The [exclusive-environment decision](2026-10-17-exclusive-review-environment.md)
defines configured clones and review content as dedicated system resources.

This replaces only PR worktree placement in the
[user-home configuration decision](2026-10-16-user-home-review-configuration.md).
Configuration, SQLite, sessions, the instance lock, logs, caches, and temporary
files remain under `~/.daynight/`. The foreground execution model, per-PR session
reuse, and cleanup ordering remain unchanged.

The global in-process review-worker limit is named `maxConcurrentWorker` in the
YAML configuration. It limits parallel PR review work without introducing another
process layer. The coordinator enforces this capacity across review preparation
and execution; closure cleanup shares the PR reservation without taking a review slot.

## Alternatives

**Keep PR worktrees under the user-home state directory.** The original layout
centralized generated files, but separated disposable checkouts from the local
repository's `.worktrees/` convention. Repository-local placement keeps those
checkouts with their source repository while retained state remains independent.

## Consequences

Worktree paths are deterministic per repository and PR. Cleanup must verify
registered ownership rather than treat the whole `.worktrees/` directory as
application-owned. Removing a checkout does not remove its retained session or
review history. Platform verification must cover repository-local paths and the
shared concurrency limit. There is no deployed runtime data to migrate.
