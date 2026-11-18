# Agent Note: Project Repository Resolution Tests

Status: implemented

## Problem

Repository resolution service tests controlled DAO pages while executing Core
matching and pagination. This coupled snapshot coordination to business rules
and did not independently verify the service's direct operation inputs.
Registration tests also wrote whole pages of projects to prepare candidates for
Core matching, even when their assertions concerned scan continuation or refusal.

## Decision

`NewProjects` binds `core.FindRepository` per instance. Resolve tests execute the
public entry point and real snapshot completion handling with a controlled find
operation, checking its context, snapshot-bound reader, principal, match and
call count. Principal and address validation remain real. The Core pagination
test owns the full matching matrix, including cursor positions and errors.

Registration tests run the real matcher over controlled DAO pages to verify the
second page is consulted before reuse or creation. They also verify validation
before storage and preserve discovery errors without entering creation. The
database-backed registration test covers persisted creation and reuse, visibility
of a competing private project, and the saved project count after a refusal.
The Project DAO suite checks visibility filtering and SQL keysets.

## Alternatives

**Keep DAO-driven service resolution tests.** They exercise matching but mix
Core decisions into snapshot coordination and do not independently check the
operation boundary.

**Replace all repository operations together.** Registration also performs
creation. Its coordination warranted a separate boundary with real Core lookup
and independent persistence coverage.

**Write a full database page for each registration scan.** It would verify the
combined SQL and Core traversal, at the cost of repeating SQL insertion for
candidates whose only purpose is providing known page results. Direct Store
tests already exercise the visibility and keyset rules.

## Consequences

The controlled Resolve operation verifies completion precedence and result
suppression. Registration's controlled pages exercise the same scan and cursor
logic with explicit bounds and without database writes. The genuine persisted
creation and visibility assertions still run in isolated PostgreSQL.
