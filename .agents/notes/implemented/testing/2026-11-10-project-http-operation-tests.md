# Agent Note: Project HTTP Operation Tests

Status: implemented

## Problem

Project HTTP tests prepared fixed identities and responses through real login,
business operations and PostgreSQL schemas. Protocol rejection tests paid for
those resources, and mixed assertions obscured which tests proved HTTP behavior,
business decisions and durable transaction effects.

## Decision

Project and Membership HTTP adapters consume interfaces containing the business
operations they actually invoke. Authentication consumes the real request
parser's `Require` and `Origin` capabilities. Strict operation callbacks supply
results, refusals and completion failures while checking the principal, request
context, IDs, inputs and call counts. Malformed protocol input is rejected before
business work. Ordinary Project HTTP tests clear database and UniAuth fixture
configuration before discovery and execute without those services.

HTTP tests retain real routing, request parsing, authentication headers and
cookies, response encoding, error mapping, log redaction, cancellation and failing
ResponseWriter mechanisms. Supplied transaction outcomes only prove their HTTP
representation. Actual PostgreSQL COMMIT response loss and persisted readback,
Project deletion history and retirement effects, and retained files are verified
at their storage, coordination and resource owners. Independent rule tests own
membership, transfer and metadata admission decisions. The
[Project architecture decision](../architecture/2026-11-05-server-project-boundaries.md)
owns production business and transaction responsibilities.

## Alternatives

**Replace only the database with DAO mocks.** Real service and core decisions
would still run beneath HTTP tests, preserving incidental setup and coupling
protocol assertions to lower business behavior.

**Move all mixed tests to API integration.** This would make the normal-flow
integration suite own protocol refusals, failure matrices and storage mechanisms.
Splitting each assertion by its actual responsibility preserves those guarantees
without duplicating a complete application in handler fixtures.

**Treat a post-commit synthetic error as COMMIT response loss.** A synthetic
error after a successful driver commit does not exercise a driver that never
receives PostgreSQL's commit confirmation. The wire failure remains a real Store
witness with independent persisted readback.

## Consequences

Protocol tests no longer need database schemas or login flows. Consumer
interfaces make direct business calls explicit and add compile-time agreement
with the production services. Tests must configure every invoked operation and
assert its count; unexpected calls fail immediately. Moving persistence
observations to lower owners changes package counts and costs, so performance
comparisons include receiving packages and distinguish local package time from
hosted CI completion time.
