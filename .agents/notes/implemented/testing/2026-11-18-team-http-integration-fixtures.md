# Agent Note: Team HTTP Integration Fixture Lifetime

Status: implemented

## Problem

The physical Team HTTP tests initialize a separate PostgreSQL schema and
test identity gateway for every scenario, including both response-loss
children. Most assertions are against a particular actor, Team, member,
invitation or Project grant. The metadata limit test intentionally reads
whole Team and membership tables before and after rejected writes.

## Decision

`TestTeamHTTPPostgres` owns one isolated PostgreSQL schema, pool, test identity
gateway and real Identity service. Its sequential cases allocate fresh
authentication adapters, muxes and logs and use role names with a stable
scenario suffix at login. The suffix prevents an earlier case from creating
a later case's account while preserving the original profile-source prefix
checked for log redaction.

The metadata case runs first and retains its whole-table before and after
comparison. Other cases only assert against their own actors and resources.
The response-loss variants create independent pgx observers of the same
scenario's committed writes and close them before proceeding to the next
case. The last-admin case continues to run concurrent mutations and query
the persisted role count. HTTP authentication and routing, Team Service,
Core rules and PostgreSQL operations stay active across all scenarios.
[Team service test boundary](2026-11-09-team-service-test-boundary.md)

## Alternatives

**Use separate schema and gateway setup for every scenario.** This repeats
infrastructure when case-owned actors and rows already prevent state from
carrying into later assertions.

**Share a whole initialized HTTP harness.** Reusing the same mutable logs,
handler and authentication state would make observations from different
scenarios harder to isolate. Keeping those objects local allows each
scenario to own its request and diagnostic evidence.

## Consequences

The nine scenarios, including both response-loss variants, use one database
and gateway setup. The PostgreSQL fixture remains required for their committed
readback, race and rollback assertions. Scenarios remain selectable as
subtests. The parent closes the shared infrastructure after all cases finish.
