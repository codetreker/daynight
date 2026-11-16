# Agent Note: App-aware Resource Retirement

Status: implemented

## Problem

Project ownership and deletion change the authority for an App connection, while Team deletion must remove only that Team's usage grants. App cleanup can finish during a lock wait, so a candidate identity read before the wait cannot establish what still needs retirement.

## Decision

Dedicated Project and Team lifecycle scopes bind the existing business operations and actual App cleanup to one transaction. Coordinators lock Project or Team roots before Apps and reread connection or grant facts after waiting. Actual transfers stop synchronization even when both Teams use the same App. Project deletion retains historical Worker and Session retirement guarantees through a raw deletion marker without the old global-App callback. The [retirement design](../../../../docs/design/github-app-resource-retirement.md) owns the full mechanism.

## Alternatives

**Add App cleanup to the existing deletion marker.** Existing production callers still follow the global-App lock order. Replacing the callback early would change those callers before the coordinated adoption and could acquire App roots after connection locks.

**Treat a deleted candidate App as an immediate failure.** A concurrent App deletion may have already cleared every binding. A new statement after acquiring the App lock distinguishes completed cleanup from a retained invalid reference.

## Consequences

The final lifecycle coordinators are independently executable while public wiring retains its existing behavior until adoption. Cleanup preserves App and grant identity tombstones, historical pull requests, direct Project grants and invitations. Lock holding grows with the affected grant set; no network request is performed within these transactions.
