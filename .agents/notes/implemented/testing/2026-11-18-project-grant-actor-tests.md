# Agent Note: Project Grant Actor Tests

Status: implemented

## Problem

The Project membership identity checks and actor access tests created projects
and promoted members before reaching the behavior under test. Identity mismatch
must return before entering storage. A successful self-mutation must read the
actor's current access before reporting a response.

## Decision

The preflight cases use a store that fails on any scope entry. The self-removal
and self-demotion cases execute the real Service callback and Core grant
operations with explicit scoped DAO facts. They check authorization before the
mutation, the exact grant operation, the access read after the mutation, and the
eligibility refresh. Separate controlled requests verify the subsequent
refusal after loss of access or administrator role.

Real PostgreSQL grant tests retain persisted records and access projections,
concurrent version claims, and rollback after SQL faults.

## Alternatives

**Keep the database fixture for each actor case.** It supplies current access
and grant facts and proves persisted effects. Preflight and Service
coordination can be observed through the scope and DAO operations, while
the existing Store tests cover actual persistence and access.

**Return a prepared grant result from a Core substitute.** This would skip the
post-mutation access read and Core role decisions that these tests verify.

## Consequences

The selected tests can run without PostgreSQL. Controlled access facts prove
how the real operations consume and return those facts. The Store suite
continues to establish how PostgreSQL produces them.
