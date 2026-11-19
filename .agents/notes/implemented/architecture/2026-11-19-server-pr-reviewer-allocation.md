# Agent Note: Server allocation of PR reviewers

Status: implemented

## Problem

The server knows which pull requests are open and which Workers are connected.
A PR needs a stable reviewer across updates, idle periods, and repeated
discovery. A worker that later becomes available should get considered even
when GitHub has no new PR event.

## Decision

The GitHub service periodically reconciles persisted Open PR facts with
worker-owned opt-in, project selection, current access, and recent activity.
PostgreSQL stores one assignment per project and GitHub PR identity. See the
[allocation design](../../../../docs/design/pull-request-reviewer-allocation.md)
for eligibility, ordering, and lifecycle.

## Alternatives

**Allocate during GitHub publication.** Coupling publication to assignment would
tie synchronization failures to Worker availability. Waiting PRs would need a
second trigger whenever an eligible Worker returned.

**Use development Task capacity.** A delivery Agent can retain its Task slot
while waiting for review. Long-lived PR ownership also outlasts individual
review executions. Neither count measures a review execution slot.

## Consequences

The service can expose a persistent assignment before Worker review execution
exists. The review execution flow will decide when to start a round and how to
admit active review work. A scan that overlaps a change can leave work queued
until its next pass.
