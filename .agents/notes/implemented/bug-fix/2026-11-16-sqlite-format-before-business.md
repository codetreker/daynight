# Agent Note: Commit SQLite Format Before Business Admission

Status: implemented

## Problem

A business startup refusal could roll back an otherwise successful SQLite format
conversion. A later connection then continued to encounter the old format even
though the refusal concerned a ticket, generation, or other business condition.
Lease acquisition and cleanup also needed to distinguish a committed conversion
from the outcome of the subsequent lease insertion.

## Decision

The SQLite opener commits format work, restores connection settings, and reports
completion before returning. Business callers then use an independent immediate
transaction that rechecks the current format. Controller storage permits span
both transactions and connection cleanup. Lease acquisition is confirmed only
when its business COMMIT returns; an unknown outcome retains the possible nonce.
The [SQLite design](../../../../docs/design/cli-sqlite-migrations.md) owns the
connection, error, and release contracts.

## Alternatives

**Keep startup inside the format transaction.** The original
[SQLite migration decision](../../archived/architecture/2026-10-30-cli-sqlite-migrations.md)
combined conversion and startup to avoid exposing a partially initialized store.
That coupling makes a business refusal undo completed format work, and cannot
report the two transaction outcomes independently.

**Use a savepoint for business admission.** A savepoint cannot make the format
durable before the outer transaction commits, so a failed outer transaction still
loses the conversion.

## Consequences

A second writer transaction adds a lock acquisition and must recheck the format
and business identity after the first commit. A successful format report proves
neither business admission nor a complete, healthy business dataset. Real SQL,
commit, rollback, and close failures retain their own outcomes and causes; a
possibly open connection keeps the associated permit. No additional lease
format version or general recovery mechanism is introduced.
