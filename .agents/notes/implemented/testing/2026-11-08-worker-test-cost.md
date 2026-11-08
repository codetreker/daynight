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
deleted task observations, permission revocation, and early stream termination.
A transaction observer checks PostgreSQL's actual result column types and
rejects JSON payload columns or individual-record reads. Each summary stream
uses one query. This protects the SQL projection without relying on large
ignored values or matching SQL text.

Worker snapshot and configuration scenarios execute in `service/worker` once.
Its fault helper preserves the root tests' nonempty messages and transaction
outcome assertions. The concurrent bootstrap test retains paired result/error
observations and checks the returned desired configuration before reading it.
Root service tests retain their distinct Task and Project integration cases.

The [Worker boundary decision](../architecture/2026-11-05-server-worker-boundaries.md)
owns production responsibilities, and the [response budget decision](../architecture/2026-11-07-encoded-response-budgets.md)
owns the summary projection and encoded limits.

## Alternatives

**Keep a smaller arbitrary large field.** Its successful decode would still not
prove that complete JSON was excluded from the result. Result metadata directly
observes that boundary with ordinary fixture data.

**Delete root copies without preserving helper assertions.** Identical test
bodies can invoke helpers with different checks. Keeping only fault codes would
lose the root tests' error message and transaction-envelope proof.

## Consequences

The tests retain row-count, authorization, streaming, configuration CAS and
failure semantics while avoiding repeated Worker scenarios and bulk unused
data. The result observer intentionally rejects a summary implementation that
transports JSON payloads, even if it later extracts the same visible fields.
Performance results remain source- and environment-specific; reducing fixture
work or package time does not by itself establish shorter CI completion.
