# Agent Note: Prompt SQL and Snapshot Test Owners

Status: implemented

## Problem

A root PostgreSQL Prompt test combined conditional insert/update races and ABA
revisions with snapshot lifetime. The DAO package already owned conditional
writes in a separate schema fixture. This split repeated setup and made one
mixed failure depend on both SQL and scope responsibilities.

## Decision

The existing root completion test shares its fixture with the real snapshot
proof. It creates a committed Prompt, establishes the production factory
snapshot through metadata and text reads, commits an interleaved update, and
observes the original revision/text until the snapshot ends. Fresh Store reads
observe the committed update and reject a proposed update after callback refusal.
A directly supplied `version_conflict` refusal retains its identity and code
through the real Prompt writer's error wrapping, independently from the DAO's
conditional-write decision. The pre-canceled write still proves that its callback
is not invoked.

The existing DAO conditional-write test receives the committed CAS lifecycle
after its original rollback and closed-transaction checks, using the same schema.
Actual holder and contender transactions execute conditional creation/update,
with PostgreSQL backend-lock observations before holder commit. Fresh DAO reads
retain the winning text, stale refusal and empty/again ABA revisions. Operation
cancellation and drain precede held transaction cleanup; expected conflicts do
not suppress rollback failures.

The [test-writing rules](../../../../docs/writing_tests.md) assign snapshots and
completion to the implementation root, and SQL/mapping to its DAO child. Both
fixtures use the current schema snapshot; their consolidation does not remove
migration replay. The schema-column, primary-key and empty-table assertions
remain in the migration test.

## Alternatives

**Move the entire mixed test to the DAO package.** This would leave snapshot and
transaction completion assertions with a SQL implementation owner.

**Delete duplicate conditional-write scenarios.** The original committed races,
stale expected revision and ABA inputs are distinct from the existing rolled-back
DAO matrix and retain meaningful fault detection.

## Consequences

The root loses one database fixture while the existing child fixture receives
its independent SQL observations. Scope and SQL failures remain attributable to
their owners. Measurements include both receiving packages and command wall
time; package durations alone do not establish shorter CI completion.
