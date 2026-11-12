# Agent Note: Release Clears Current Ownership

Status: implemented

## Problem

A released Worker record served both as current Task ownership and execution
history. It imposed status and withdrawal rules on a task whose execution had
already ended, while Session and archive records already retained their own
identities and resource responsibilities.

## Decision

Release requires the original active claim, owner or administrator, exact version
and confirmed stop. It returns the Task to todo, clears execution timing and
removes worker and sessionStartup. Session and archive history remain bound to
their original identities. Ordinary eligibility and local resource barriers
apply to the next claim. Existing released rows are converted transactionally,
including hidden and deleted tasks, with task version and project cache epoch
updates. The server and the CLI release response consumer switch together.

This replaces the retained released state described by the [candidate](../bug-fix/2026-11-12-worker-released-candidates.md)
and [resume retirement](2026-11-12-retire-worker-resume.md) decisions; their
scheduling, unknown outcome and resource fencing rationale remains. The
[claim architecture](../../../../docs/design/daynight-worker-claims.md) owns the
current protocol and switching procedure.

## Alternatives

**Retain released ownership and allow ordinary candidates.** This supports
reacquisition but leaves special status, withdrawal and Session rules attached
to an execution that has ended.

**Keep a permanent historical identity registry.** This would reject deliberate
reuse of every prior identity but needs a new durable guarantee and cannot
reconstruct claims that never created a Session.

## Consequences

A Task without worker no longer proves which release request succeeded. Unknown
responses remain unknown; original resources still require reconciliation. A
normal Worker creates fresh IDs, but the service cannot enforce permanent
historical uniqueness after the record is removed. Deployment requires stopping
old service instances and managing Workers before migrating, then starting the
matching server and CLI; old release writers cannot run concurrently.
