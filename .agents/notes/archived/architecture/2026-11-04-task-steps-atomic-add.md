# Agent Note: Atomic Task Steps additions

Status: implemented

## Problem

Adding an ordered Task record must preserve the collection and its shared parent
version as one state. Task metadata writers can race with additions, existing
Steps can already consume the complete response budget, and inserting a row can
require shifting many positions. A failed operation must not leave partial order
or touch unrelated execution data. The caller also needs to distinguish a
confirmed database result from an unconfirmed Commit or a lost HTTP response.

## Decision

The [resource contract](../../../../docs/spec/daynight-task-steps.md) provides
collection POST for append and before/after insertion. It reuses the normalized
rows, deferred position uniqueness and neutral codec established by the
[read resource decision](2026-11-03-task-steps-read-resource.md). Identity is a
caller-chosen task-local eight-hex value; a duplicate is always a conflict.

The existing project transaction locks the project, checks membership and locks
a narrow Task header. Neutral identity and exact-version admission are shared
with Task writers; their Worker compatibility and lifecycle rules stay in Task
callers. Steps checks the parent tombstone and observed version before looking
up collection identity, and checks a duplicate new ID before its anchor. Current
rows are validated and copied into an immutable insertion candidate.

Before any data mutation, add checks int64 exhaustion, samples the database UTC
microsecond clock, assigns the new Step and parent times, increments the candidate
version and encodes the complete resource through `internal/core/task/codec`. The same
codec accounts for escaping, terminal LF and 19 parent-version digits. Only a
candidate within 64 MiB reaches position shifts, insertion and a parent touch
that changes `version` and `updated_at` alone. Existing content timestamps and
all Task business, dependency, property, timing and Worker/Session data remain
unchanged. The full Task updater is not part of this write.

The existing shared `transact` owner preserves operation, commit and cleanup
stages with original error chains. Its result distinguishes `committed`,
`not_committed` and `unknown`; independent bounded rollback survives request
cancellation. Callback failure and successful rollback confirm non-commit. An
explicit `ErrTxCommitRollback` confirms rollback; other failed Commit results
remain unknown. Successful Commit stays committed even if later cleanup or
response work fails. This follows the pinned driver's
[Commit behavior](https://github.com/jackc/pgx/blob/5e583fa7aabfa88b796292f849fc9d7d75ac159d/tx.go#L190-L223):
Commit closes the transaction after any attempt, so cleanup `ErrTxClosed` cannot
establish that a failed Commit rolled back.

The handler owns request logging and response completion. Service/store return
facts without importing server code. Logs use fixed diagnostics, safe cause
classes and SQLSTATE, and record transaction outcome independently from response
outcome and written bytes. Recovery GET uses the existing request ID with an
optional `.rN` suffix and reports current version and presence only. Correlation
creates neither a durable operation identity nor historical attribution.

## Alternatives

**Use the full Task updater.** It rewrites properties and dependencies and can
freeze Sessions. Those are lifecycle effects unrelated to an ordered record,
so a narrow parent touch is required to preserve ownership and timing.

**Write rows before checking response capacity.** This makes capacity refusal
depend on rolling back work that was avoidable. The exact candidate encoding
also fixes the only response bytes before persistence, so admission and output
cannot diverge through a separate estimate or later timestamp assignment.

**Add a Steps transaction executor or reuse the Thread executor.** A separate
executor would duplicate transaction completion and cleanup semantics. Thread
has a different admission and lock order. Enriching the existing project
transaction owner preserves the established Task concurrency path and keeps
completion classification in one owner for its existing callers.

**Treat a closed transaction or HTTP failure as rollback.** The driver can close
a transaction after an applied Commit whose receipt was lost. Such a claim can
cause a duplicate retry. Retaining unknown completion and the original identity
allows read-only reconciliation without inventing success or rollback.

## Consequences

Same-version additions and Task metadata updates serialize through the existing
locks, so only one actual change can succeed. Add works in every Task state,
with disabled automatic execution and without a Session. Partial row changes
and parent touch are atomic under confirmed rollback; cleanup/internal failure
cannot be downgraded to a normal business refusal.

Insertion is linear in affected rows, while candidate validation and complete
encoding remain linear in collection size and encoded bytes. A maximum resource
uses substantial request memory. Real PostgreSQL and HTTP boundary tests run
under an opt-in stress tag separately from routine CI; failure-path tests also
check actual rollback, ambiguous Commit and response loss. Logs do not replace
client resource validation or prove receipt.

The same admission, codec, narrow parent touch and completion facts also serve
[existing-target content and status changes](2026-11-04-task-steps-target-change.md).
Add retains its insertion-specific candidate and always changes the collection;
the target-change path owns semantic no-op behavior. Unsupported methods retain
explicit method errors. These primitives have actual consumers; no persistent
operation ledger, replay queue or retry policy is introduced. Further operations
must preserve the same shared-version, preflight and completion guarantees.
