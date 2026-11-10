# Agent Note: Task OAuth Family Locks

Status: implemented

## Problem

Refresh rotation preserves unexpired access tokens from the same grant. A Task
Session dispatch holds the Session row while reauthorizing its original Actor;
concurrent submission holds its credential while waiting for that Session.
Revocation can delete the dispatch Actor's older token and then wait for the
submission's newer token. Dispatch then waits for revocation, closing a cycle
across three transactions. Compatible reads of one token do not prove safety
for a rotated family.

## Decision

Task OAuth send and receipt admission, including original-Actor checks during
dispatch, acquire the grant `FOR SHARE` before the access token `FOR SHARE`.
Revocation and refresh already acquire the grant `FOR UPDATE`, so they wait
before changing family state. A dispatch reader can join a shared grant lock
while revocation is queued behind another admission; no token has been deleted
by that waiting revocation. This protocol does not depend on token deletion
order.

After both locks, a separate query checks user and token identity, resource,
scope, revocation and both expiries against the database clock. Credential and
Project authorization still precede loading or attaching live Session state.
The [Task Session design](../../../../docs/design/task-session-send.md) owns
the complete request and dispatch behavior. This specializes the earlier
[credential family decision](../architecture/2026-11-06-mcp-oauth-credentials.md)
for the Task Session lock relationship; Thread and Bot adapters keep their
existing credential checks.

Credential cleanup selects expired rows with `FOR UPDATE SKIP LOCKED`; it does
not wait on a token retained by an admitted transaction. Grant cleanup also
skips locked grants and requires their terminal time to be at least 30 days
old. It cannot create revocation's partial-delete-and-wait cycle.

## Alternatives

**Retain only access-token locks.** Readers of the same token are compatible
even with a queued delete, but rotation creates multiple rows. A revoker can
hold one and wait for another while submissions and dispatches wait in opposite
Session order.

**Load the Session before credential authorization.** Loading attaches live
state, and missing or deleted associations can discard it. Moving that work
ahead of authorization would change the failure boundary; an additional lock
phase or a larger loading split would be needed to preserve it. A shared family
lock removes the cycle without changing that boundary.

## Consequences

Task OAuth checks add one query and retain a shared grant lock until their
transaction finishes. Refresh and revocation can wait longer behind these
operations, while concurrent admissions and dispatch reads remain compatible.
Database errors retain their causes and SQLSTATE; no deadlock retry converts a
failed transaction into a successful operation.

Real PostgreSQL tests rotate a family, observe Session and grant waiters, and
verify that both token Actors are refused after revocation commits. Grant
scope, expiry and revocation changes during a lock wait are rechecked. Any new
OAuth entry point that holds a credential while waiting for a Task Session must
participate in this family protocol.
