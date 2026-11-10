# Agent Note: Project Repository Resolution Tests

Status: implemented

## Problem

Repository resolution service tests controlled DAO pages while executing Core
matching and pagination. This coupled snapshot coordination to business rules
and did not independently verify the service's direct operation inputs.

## Decision

`NewProjects` binds `core.FindRepository` per instance. Resolve tests execute the
public entry point and real snapshot completion handling with a controlled find
operation, checking its context, snapshot-bound reader, principal, match and
call count. Principal and address validation remain real. The Core pagination
test owns the transferred candidate, page and error cases, including exact cursor
positions and complete results.

## Alternatives

**Keep DAO-driven service resolution tests.** They exercise matching but mix
Core decisions into snapshot coordination and do not independently check the
operation boundary.

**Replace all repository operations together.** Registration also performs
creation and retains its existing real Core call and database integration tests;
its coordination has separate obligations.

## Consequences

The controlled operation verifies completion precedence and result suppression,
not SQL cancellation or persistence. Core retains the full pagination proof.
Registration, creation and physical storage tests remain in their existing
owners. Comparisons include the receiving Core work and do not imply CI savings.
