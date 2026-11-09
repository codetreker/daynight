# Agent Note: Team Failure Fixture Isolation

Status: implemented

## Problem

The Team query cancellation and lifecycle SQL failure matrices created a complete
schema and identity fixture for each of their nine cases. Their persisted Team
and membership rows must remain unchanged after each failure, so this repeated
setup did not contribute to the cancellation or rollback proof. Sharing state
without checking those rows and removing each fault would allow one failed case
to contaminate later cases.

## Decision

Each matrix owns one isolated parent fixture. Its synchronous subtests retain
the original SQL operations, trigger failures, query-start cancellation points,
error chains and transaction classification. Every case reads complete Team and
member profiles before and after the operation and compares them with the parent
baseline. A failed subtest, including cleanup failure, stops its parent matrix.
Rows are never reset to make the next case pass.

Cancellation cases each own their operation context, tracer, hit observation
and pool. Pool reuse is checked before the subtest closes that pool. Lifecycle
cases register fault cleanup before installing DDL. Cleanup has an independent
bounded context, attempts both trigger and function removal, and reports every
failure before checking their actual catalog absence.

The shared catalog checker accepts an explicit context and returns errors. It
owns both the table-scoped trigger and schema-scoped function predicates. The
existing assertion adapter retains fatal body-phase behavior; cleanup reports
errors without terminating the remaining cleanup steps. Test contexts are
canceled before cleanup, so they cannot perform that catalog observation.

PostgreSQL sequences can advance despite transaction rollback. These tests
compare persisted row versions and timestamps without restoring or asserting
rollback of the membership version sequence.

## Alternatives

**Keep a schema per case.** This isolates faults but repeats all migrations and
identity setup despite requiring the same unchanged persisted state.

**Restore rows between cases.** This could hide a failed rollback. Baseline
comparisons and immediate termination expose contamination directly.

**Duplicate catalog SQL in the Team cleanup.** This would give two owners to the
same removal condition. An error-returning checker supports both fatal body
assertions and nonfatal cleanup with one query.

**Add context to the fatal assertion and update every caller.** Existing callers
already observe the catalog in their live subtest bodies. That signature change
would still need a separate nonfatal cleanup policy. Separating the check from
failure reporting expresses both existing uses directly.

## Consequences

The two matrices initialize two schemas instead of nine. They add full-state
guards, checked fault cleanup and pool reuse observations. These observations
have their own cost; fewer fixtures alone do not establish package or CI savings.
Actual SQL, transaction rollback and fresh reads remain PostgreSQL proofs.

Fixture reuse remains local to each matrix. Successful writes, parallel cases or
new mutable facts require reassessing the isolation conditions. The snapshot
test and other users of the shared fatal assertion retain their original scope.
