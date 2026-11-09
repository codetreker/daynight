# Agent Note: Worker test cost

Status: implemented

## Problem

Worker summary integration tests stored 100 telemetry objects with an unused
4 MiB string each. The normal decoder ignored that field, so the 400 MiB fixture
did not directly reject a regression that read complete snapshots. Root service
tests also repeated the same Worker snapshot and configuration operations as
their owning service package, including separate database initialization.

## Decision

The summary integration test retains 100 small stored Workers, visible and
deleted task observations, permission revocation and count-based continuation.
A transaction observer checks PostgreSQL's actual result columns. It permits
only the projected observation-time JSON scalar, named `task_observed_at`, and
rejects other JSON columns or individual-record queries. Each summary page uses
one query. This protects the SQL projection without relying on large ignored
values or matching SQL text.

The original summary reader used a stream and tested early termination. The
[canonical-read decision](../simplification/2026-11-09-worker-bot-canonical-reads.md)
replaces that stream with `WorkerSummaryPage{Items,HasMore}`. The test checks the
remaining 99 items through count pagination and current visibility; three page
reads each execute one summary query. Service tests preserve clock, DAO and
transaction error chains, cursor identity and final-page termination.

Worker snapshot and configuration scenarios execute in `service/worker` once.
Its fault helper preserves the root tests' nonempty messages and transaction
outcome assertions. The concurrent bootstrap test retains paired result/error
observations and checks the returned desired configuration before reading it.
Root service tests retain their distinct Task and Project integration cases.

The [Worker boundary decision](../architecture/2026-11-05-server-worker-boundaries.md)
owns production responsibilities. The
[response budget decision](../architecture/2026-11-07-encoded-response-budgets.md)
records the original summary projection and encoded-limit rationale; the
canonical-read decision owns the current projection and count-page mechanism.

## Alternatives

**Keep a smaller arbitrary large field.** Its successful decode would still not
prove that complete JSON was excluded from the result. Result metadata directly
observes that boundary with ordinary fixture data.

**Delete root copies without preserving helper assertions.** Identical test
bodies can invoke helpers with different checks. Keeping only fault codes would
lose the root tests' error message and transaction-envelope proof.

## Consequences

The tests retain row-count, authorization, count pagination, configuration CAS
and failure semantics while avoiding repeated Worker scenarios and bulk unused
data. The result observer rejects full JSON payload transport even when an
implementation later extracts the same visible fields, while allowing normal
decoding of the projected timestamp scalar. Performance results remain source-
and environment-specific; reducing fixture work or package time does not by
itself establish shorter CI completion.
