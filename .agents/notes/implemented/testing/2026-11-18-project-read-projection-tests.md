# Agent Note: Project Read Projection Tests

Status: implemented

## Problem

Project read tests seeded identities, projects, and grants to check cursor
handling, access projections, and input refusals. The SQL suites already covered
visibility and keyset order, often using the same read APIs.

## Decision

Service list and access tests execute the real entry points and Core rules over
a controlled snapshot reader. The reader checks canonical IDs, the caller,
the requested scope, and the exact continuation position. Tests check complete
returned projects and grants, continuation and end-of-list results, and
refusals for invalid or differently scoped cursors. The same access fixtures
exercise the full grant version above JavaScript's safe integer range.

Store tests retain real visibility filters, SQL keyset ordering and repeatable
snapshots, authorization projections, and exact grant-version decoding.
Missing projects and a missing team-membership relation are observed through
the actual DAO.

## Alternatives

**Keep the database fixture for Service pagination.** This exercises both the
Service cursor boundary and SQL ordering. It repeats database setup even for
invalid inputs that must never reach the snapshot.

**Stub the Service read result.** A completed page would omit the cursor and
project projection logic these tests verify. A controlled DAO page preserves
that logic and leaves SQL ordering with its real database witness.

## Consequences

The selected Service suite runs without PostgreSQL. The Store witnesses reuse
existing schemas. The two test scopes separately cover forwarding and
conversion of read facts and the queries that produce them.
