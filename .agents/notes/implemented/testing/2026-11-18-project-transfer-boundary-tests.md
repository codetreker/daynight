# Agent Note: Project Transfer Boundary Tests

Status: implemented

## Problem

The Project transfer tests created PostgreSQL schemas and seeded owners,
Teams, and membership rows to exercise preflight, missing targets,
authorization, version checks, and transaction failures. The same fixtures
also contained proofs that depend on real SQL and independent committed reads.

## Decision

Service tests use a fail-on-access store for preflight and inject the original
cancellation at the snapshot or write entry. The preview and write tests
execute the real Service and Core code with explicit scoped DAO facts. They
check the source Team administrator requirement, the destination preview and
nullable actor role, ownership and Team version conflicts, and authorization
query failures. Both directions of version mismatch are covered, including a
return to the original Team with a newer ownership version.

The write fixture checks the move and actor access reread in order, followed by
eligibility refresh filtered to the affected Project. Same-Team saves also
refresh eligibility before completion, including at the ownership version
limit. Successful callbacks stage a complete receipt. An unconfirmed
completion suppresses that receipt and preserves the operational error.

PostgreSQL tests use the real write scope to commit a move with grant and
invitation rows present. Independent reads check the complete membership rows,
destination and incremented ownership version, and the original actor's loss
of access. The DAO suite also checks the actual destination role composition
and the SQL error returned by access queries in both scopes. The failed write
reports a non-commit outcome and leaves ownership intact. The physical suites
retain actual lock waits, cancellation without late writes, rollback, and
lost commit confirmation. A Service test executes a real same-Team save and
compares the entire Project from independent reads, including its timestamps.

## Alternatives

**Use an isolated schema for every transfer case.** This exercises the actual
database even when the proof only needs known facts or a controlled completion
outcome. It repeats schema and identity preparation and makes it harder to
target a specific callback error or commit outcome.

**Stub the whole transfer operation.** That would remove the rule and
orchestration evidence for a refusing transfer, a cross-Team move, and a
same-Team save that still refreshes eligibility. Replaying the whole Service
workflow in Store tests would also place rule and orchestration assertions
outside their owner.

## Consequences

The transferred Service cases run without PostgreSQL. Reusing the Store role
fixture for the committed move keeps the real membership proof without a second
schema. The same-Team Service case still needs PostgreSQL because a sequence
of mock calls cannot establish that the Project timestamps and persisted data
stay unchanged.
