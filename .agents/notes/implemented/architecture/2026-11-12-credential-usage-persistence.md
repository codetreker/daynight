# Agent Note: Credential Usage Persistence

Status: implemented

## Problem

An account's personal access token or OAuth grant needs a last recorded use time
that reflects an actual event and never moves backwards across delayed or
concurrent writes. Existing credentials have no reliable historical use time.
Metadata recording must not revive deleted credentials, change their lifecycle,
or interrupt foreground authorization while competing for credential locks.

## Decision

PAT and OAuth grant rows have nullable `last_used_at` timestamps with no default
or historical backfill. The database-neutral writer accepts bounded, uniquely
keyed and ordered events and updates only a matching owner and a later timestamp.
Its independent READ COMMITTED transaction locks all existing target rows in a
first `FOR UPDATE NOWAIT` batch before issuing conditional updates in a second
batch. A lock conflict fails and rolls back the entire metadata batch with its
cause retained. Missing rows are skipped, and existing revoked or expired grants
can retain a delayed event that occurred before their state changed. The
[authentication design](../../../../docs/design/daynight-auth.md#凭据使用时间的持久化)
owns the store contract and cleanup boundary.

The grant remains the owner of its use time across access and refresh token
rotation, complementing the [credential family decision](2026-11-06-mcp-oauth-credentials.md)
and its lifecycle and retention rules. This persistence capability does not
itself generate events. The [HTTP projection decision](2026-11-12-credential-usage-http.md) exposes the
recorded value while preserving the original OAuth v1 representation.

## Alternatives

**Write synchronously in authentication or refresh.** Waiting for a pool or row
lock, or losing the connection during metadata failure, could delay or change the
original operation's result. The separate transaction isolates that outcome.

**Update rows directly in a sorted batch.** A foreground operation can acquire
credential share locks in a different order. A waiting update can complete a lock
cycle and make PostgreSQL abort the foreground transaction; a complete NOWAIT
lock phase makes the metadata transaction give way instead.

**Derive the time from refresh history.** It would introduce pre-existing
history as a recorded use and can regress when refresh rows are cleaned while a
grant remains. A nullable grant field preserves the recorded event independently
of refresh retention.

## Consequences

Repeated or out-of-order events cannot move stored time backwards. A whole batch
can fail under lock contention and its caller must decide whether to retry; pool,
network and commit failures remain possible. A null value means no use was
recorded, not that the credential was never used. The writer completion result
does not prove that pgx has finished asynchronously destroying a failed
connection; persistence closure owns that resource. The separate
[sampling decision](2026-11-12-credential-usage-sampling.md) owns bounded in-memory
selection; event production, background execution and public presentation are
separate capabilities.
