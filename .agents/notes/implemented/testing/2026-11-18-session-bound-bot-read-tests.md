# Agent Note: Session Bound Bot Read Tests

Status: implemented

## Problem

The bound Bot snapshot error test created identities, a worker, a Bot and a
Session to reach a lookup failure or a deletion marker. The database setup
was repeated even for errors injected by the test.

## Decision

Controlled Session scopes provide the bound Bot identifier and Bot lookup
result. The real snapshot operation preserves the lower error or applies
the missing or deleted Bot classification. The test checks that those
outcomes stop before loading the Session and return no snapshot.

The real cross-instance deletion test verifies the exact refusal after a
committed Bot deletion, including an empty snapshot from the original
instance. It retains real persistence, cancellation and pending content
behavior in its existing schema.

## Alternatives

**Keep the database for every lookup error.** It supplies a real association
and deletion marker, but repeats setup for the failed lookups. The
cross-instance test already exercises the physical deletion.

**Substitute the snapshot operation.** That would skip the ordered association
and Bot lookup and the deletion decision.

## Consequences

The scoped error test runs without PostgreSQL. The existing physical
deletion test still verifies that the persisted marker blocks snapshots.
