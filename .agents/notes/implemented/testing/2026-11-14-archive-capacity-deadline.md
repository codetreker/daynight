# Agent Note: Separate archive capacity preparation from database deadlines

Status: implemented

## Problem

The maximum archive metadata probe constructs and decodes 100,000 entries before
its first PostgreSQL operation. Race instrumentation can consume the database
context's entire lifetime during that CPU work. The subsequent connection then
reports a timeout without testing persistence, even when PostgreSQL is healthy.

## Decision

Start the existing four-minute database context at the first database operation.
The Go test runner's deadline continues to bound the complete probe, including
fixture construction and decoding. Keep the exact byte and count boundaries,
race instrumentation, persistence assertions and cleanup unchanged. The probe
remains separate from routine CI.

## Alternatives

**Increase the shared context timeout.** This couples the database allowance to
machine-dependent fixture preparation and gives database work an unnecessarily
variable budget.

**Disable race instrumentation or omit PostgreSQL.** Those runs can diagnose
preparation cost but cannot replace the required instrumented persistence proof.

## Consequences

A CPU timeout and a database timeout identify different phases. Both still fail
the probe; a successful boundary decode alone does not establish that the ledger
fits PostgreSQL or that originals survive backup and restore. The
[acceptance specification](../../../../docs/spec/session-image-acceptance.md)
owns those separate capacity obligations.
