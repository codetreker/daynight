# Agent Note: Project Repository Resolution Tests

Status: implemented

## Problem

Repository resolution service tests controlled DAO pages while executing Core
matching and pagination. This coupled snapshot coordination to business rules
and left the direct operation inputs unchecked. Registration originally wrote
whole pages of projects to prepare candidates. After registration changed to a
target Team and persisted identity lookup, even confirmation and URL variants
still used a schema to supply fixed match results.

## Decision

`NewProjects` binds `core.FindRepository` per instance. Resolve tests execute the
public entry point and real snapshot completion handling with a controlled find
operation. They check its context, snapshot-bound reader, principal, match and
call count. Principal and address validation remain real. Core owns the matching
and pagination matrix, including cursor positions and errors.

The [Team-scoped reuse decision](../architecture/2026-11-18-mcp-team-repository-reuse.md)
replaced registration page scanning with a bounded persisted-identity query.
Registration tests execute the real entry point, snapshot callback and Core
creation path. Controlled DAO facts allow them to verify the principal, target
Team, exact identity and insertion arguments for Session and PAT cases. These
tests exercise ambiguity, confirmation, reuse and completion failures. Core
checks the URL identity vectors directly.

The PostgreSQL Project DAO tests verify the actual lookup predicates. The
committed occupancy test reuses two ordinary Team rows with the same identity
and adds an IPv6 row and another account's private Personal row. Independent SQL
checks the persisted identities and ownership. Real snapshot queries check
each target Team match and the exact visible Project set.

## Alternatives

**Keep DAO-driven service resolution tests.** They exercise matching but mix
Core decisions into snapshot coordination and leave the direct operation
boundary unchecked.

**Write a full database page for each registration scan.** It would verify the
combined SQL and Core traversal, at the cost of repeating SQL insertion for
candidates that only provide known page results. Direct Store tests already
exercise the visibility and keyset rules.

**Keep the database-backed registration matrix.** It couples confirmation,
URL handling and write-completion assertions to schema preparation. The
PostgreSQL receiver can reuse the existing occupancy fixture for the committed
rows and visibility evidence.

## Consequences

The Resolve and registration coordination cases run without PostgreSQL.
Registration tests can vary completion independently of the result staged by
the write callback. PostgreSQL still verifies committed creation, Team-scoped
reuse and visibility.
