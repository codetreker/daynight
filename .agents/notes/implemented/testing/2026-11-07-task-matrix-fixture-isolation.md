# Agent Note: Reuse Isolated Task Test Fixtures

Status: implemented

## Problem

Cancellation and dependency protection matrices originally initialized and
dropped a complete PostgreSQL schema for each row even when their mutable cases
could be isolated at a smaller scope. The mixed service tests needed real
transactions, cancellation causes, rollback, dependency protection and persisted
Task state, so fixture reuse had to retain those observations.

## Decision

The original status cancellation matrix created one fixture per transition and
ran its cancellation positions sequentially against the same Task graph. Each
position owned its context and traced pool and checked both Tasks against their
complete pre-operation state. A failed position stopped the remaining positions
for that transition so a damaged graph could not contaminate later observations.

The original dependency protection matrix shared one schema and principal but
created a separate Project and Task graph for every combination. Its twelve
combinations retained their status and dependency assertions.

The later [Task service ownership decision](2026-11-08-task-service-test-ownership.md)
separates the mixed tests: service rules and cancellation coordination use
explicit DAO outcomes, while direct store tests retain actual transaction,
locking and rollback witnesses. The earlier reuse choice records how isolation
was preserved while those responsibilities still shared a service fixture; it
does not define the current service dependency.

## Alternatives

**Keep a schema per case.** This provided isolation but repeated full schema
initialization and cleanup for every row, although the tests did not alter the
schema itself.

**Share a Task graph across dependency rows.** Status transitions and dependency
writes would carry state across rows. Independent Projects retained the original
case boundaries without requiring another schema.

## Consequences

The original matrix organization used three cancellation schemas and one
dependency schema, compared with nine and twelve respectively. That reuse was
valid only while every cancellation proved rollback and every dependency row
owned its Project. Tests that mutate schema or share mutable state still need
isolation appropriate to those resources.

The current service suite no longer uses those PostgreSQL fixtures. Physical
proofs retain isolated database state in store tests. Neither the original reuse
nor the later responsibility split establishes a general fixture-pooling policy.
