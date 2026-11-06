# Agent Note: Cloud Project Selection and Worker Resources

Status: implemented

## Problem

A cloud Project selection can change while repository preparation, task
acquisition or native execution is in progress. A Project without a local
mapping still needs a repository, while removing one must stop execution without
changing task ownership or deleting the user's work. Failed resource observation
cannot prove that a resource is absent, and one Project's preparation failure
must not prevent independent work.

## Decision

The [configuration application decision](2026-11-04-worker-cloud-runtime-configuration.md)
retains the single commit and report owner. Project adapters resolve existing
bindings or derive local paths, prepare repositories outside the commit queue,
and report preparation and removal through that owner. Concurrent candidates
reserve validated paths before preparation; successful preparation registers the
binding. An unchanged empty clone reservation can be removed after failure,
while partial content remains for inspection.

The coordinator excludes Projects outside the effective selection from
automatic advancement and checks it again after acquisition. Project removal
cancels and joins execution jobs, then serializes direct Herdr or Web stops for
the original resources. It retains claims, worktrees and session history. Stop
failure retains capacity and is retried and reported by configuration; a
confirmed stopped execution does not permanently occupy a slot merely because
its worktree remains. Re-selection waits for an already-started removal. The
[Worker design](../../../../docs/design/daynight-worker.md#实际配置消费)
owns the runtime details and failure boundaries.

## Alternatives

**Stop inside the heartbeat.** Repository and native operations can exceed a
report interval, preventing timely delivery and error observation. The existing
independent application loop keeps the configuration channel available.

**Release claims or clean worktrees on removal.** That would change task
lifecycle and destroy the preserved context required for manual disposition.
Direct stopping leaves those responsibilities with the task system.

**Keep the global Git discovery gate.** It preserves unknown resources but
blocks healthy Projects when an unrelated retained repository is unreadable.
Project-scoped observation retains known ownership and refuses decisions that
require a failed observation while allowing independent Projects to advance.

## Consequences

Cloud selection controls future scheduling without changing Task or claim
formats. Local mappings remain for inventory and manual recovery; changing
repositoryRoot does not relocate existing bindings. The application loop must
join cancelled work and preserve the original removal revision, and resource
failures remain visible until confirmed and reported. Repository and process
observations remain necessary: a retained directory alone is neither proof of a
running process nor permission to delete it.
