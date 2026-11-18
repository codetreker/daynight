# Agent Note: Project Read Error Fixtures

Status: implemented

## Problem

The Project Service error tests opened new database schemas to obtain a closed
pool, a missing-relation error, and a Project timestamp that cannot be encoded in
a cursor. Each scenario exercised a different boundary. Collecting all of them
through the Service required repeating expensive setup for failures that can
also be observed directly at the Store boundary.

## Decision

Service tests use controlled snapshot and creation writers to report precise
begin and query failures. Get, List, and Create still execute their real error
handling and retain the error chain. A controlled page containing an
unrepresentable timestamp flows through the real List and cursor encoder.
The [preflight tests](2026-11-06-project-request-validation-isolation.md) continue
to check inputs that must fail before any storage call.

Store tests own closed-pool callback exclusion and actual missing-relation
SQLSTATE and recovery. Their checks use real PostgreSQL and separate
transactions for independent SQL errors.

## Alternatives

**Use a complete database fixture for each Service failure.** This exercises
the entire stack for each error but ties Service assertions to database setup
and schema mutation. The query and connection failures can be exercised
directly with the Store capabilities that report them.

**Rely on controlled errors alone.** They establish Service propagation and
cannot prove that the PostgreSQL driver and transaction scopes produce those
errors or leave the callback uncalled.

## Consequences

The selected Service failure tests run without PostgreSQL. Store receivers
reuse existing database fixtures. Real visibility, persisted results, and keyset
ordering retain their integration coverage.
