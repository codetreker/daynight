# Agent Note: Worker Failure Worktree Location

Status: implemented

## Problem

A current Worker failure can identify a task without showing where its local
worktree was selected, leaving operators to locate preparation and cleanup
failures manually. Arbitrary error messages can contain sensitive local data,
and monitoring details must follow current project and task permissions.

## Decision

Claim failures may carry a closed, optional project-relative worktree location
computed from the original trusted project and execution binding. Known bindings
that cannot be represented safely report a fixed unavailable reason. The
[monitoring contract](../../../../docs/spec/daynight-worker-monitoring.md)
defines the path, permission and byte-budget rules; the
[reporting design](../../../../docs/design/daynight-worker-reporting.md#当前运行监控)
explains capture. This extends the [capture](2026-11-09-worker-monitoring-capture.md)
and [storage](2026-11-09-worker-current-monitoring.md) decisions without admitting
paths into diagnostic text.

## Alternatives

**Include the absolute path or error text.** This exposes machine-specific roots
and potentially unrelated secrets, and cannot reliably identify the bound target.

**Omit paths that exceed the snapshot budget.** Silent omission makes a known
location indistinguishable from an unavailable binding. A fixed reason preserves
the distinction while keeping the failure and other metadata.

## Consequences

Operators can locate eligible failures without obtaining a directory operation or
ownership proof. Paths follow the claim's current visibility and remain bounded;
large encoded paths can become unavailable in a snapshot while the in-memory
record remains intact. Strict readers and Servers must be deployed before new
producers, and rollback requires the existing frame expiry barrier.
