# Agent Note: Project Request Validation Isolation

Status: implemented

## Problem

UUID, Project creation input, settings and pagination tests created a PostgreSQL
service fixture only to obtain a principal. Their assertions use pure parsing or reject
requests before storage, so database initialization and seeding add cost without
proving those rules. Entropy failure is also required to remain an operational
error before any transaction begins.

## Decision

Request-validation tests construct a valid Session principal with
canonical nonzero user and credential IDs. Their Project service uses a
fail-on-call mock of its existing storage interfaces: snapshot reads, Project
writes and Project creation writes panic immediately if reached, without
invoking a callback. No new production interface or database implementation is
introduced.

All original UUID spellings, invalid names, credential-bearing repository URLs,
settings versions and values, page limits, byte budgets and cursor fields remain
checked. Creation inputs retain the
principal's expected user ID. The entropy sentinel must still be discoverable
through `errors.Is`, must not become a business Fault, and the UUID entropy hook
is restored through test cleanup.

Creation, database readback, keyset paging, operational database errors and
transaction tests keep their PostgreSQL fixtures. The
[server test guide](../../../../packages/daynight-server/README.md#business-rules-and-dao-mocks)
owns the shared DAO mock and integration policy. The
[fixture construction decision](2026-11-08-go-fixture-construction.md) records the
associated input-only and native fixture preparation boundaries.

## Alternatives

**Keep the database fixture to obtain a principal.** It supplies fixed identity
facts but adds no storage observation to these tests. The retained integration
tests already establish persistence and authorization behavior.

**Use a nil store for every service invocation.** Unexpected storage would fail
indirectly through a nil call. An explicit interface mock identifies which
storage operation violated the preflight guarantee and never supplies a default
empty result that could hide access.

**Mock PostgreSQL queries.** The rules are above SQL and expect no storage call.
A driver mock would add implementation coupling without strengthening the
pre-storage ordering assertion.

## Consequences

The validation selection runs without a PostgreSQL URL and fails immediately if
preflight begins storage. Pure model and query parsing remains independent of a
backend. Global entropy cleanup remains necessary even though the fixture no
longer performs database work.

Representative grammar faults are compared against the original and isolated
tests through per-command overlays. Scope-specific timings measure local input
feedback; they do not establish whole-job or hosted CI savings.
