# Agent Note: Background TaskSync polling

Status: implemented

## Problem

An open project can remain hidden for a long time while tasks change. Pausing all
periodic summary reads leaves its task snapshot and persistent cache stale until
visibility returns. Updating those summaries must preserve account admission,
request ownership and the separate visibility rules for Session observations.

## Decision

A mounted project uses its existing TaskSync path every fifteen seconds while
visible and every five minutes while hidden. Visibility changes replace the one
interval from the transition; hiding neither requests nor cancels a read, while
returning attempts an immediate automatic read. Automatic requests skip an active
cycle and manual refresh replaces it. Window focus does not change the interval.
The [TaskSync design](../../../../docs/design/daynight-task-sync.md) owns the
scheduling and data flow. This partially supersedes the hidden polling rule in the
[automatic refresh decision](../../archived/feature/2026-10-22-project-task-auto-refresh.md).

## Alternatives

**Dedicated TaskSync admission and cache maintenance.** This would bypass the
former hidden identity barrier but duplicate identity and lifecycle ownership.
Normal visibility changes no longer pause ordinary authenticated requests or
cache access, so the existing path supports background reads while still blocking
requests during actual account-change waiting.

## Consequences

Background successes update the project snapshot and IndexedDB through the same
history and version checks. Hidden Session observations remain suppressed under
the [list admission decision](../architecture/2026-11-08-task-sync-session-list.md),
and unrelated features retain their own visibility rules. Each mounted tab still
polls independently; no cross-tab leader is introduced. Five minutes is a nominal
interval: browser throttling, freezing or discard can delay or prevent a read.
Returning visible attempts a fresh read without replaying missed ticks. A cache
notification can update the displayed snapshot without proving a failed sync
has recovered. Its asynchronous publication retains the current sync error and
manual refresh state; a successful sync clears that error.
