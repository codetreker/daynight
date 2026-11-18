# Agent Note: Worker Service Refusal Fixtures

Status: implemented

## Problem

The read-only authority and snapshot refusal service tests each prepared
PostgreSQL and inserted test identity records. The authority test already
supplied the transaction result. The snapshot test exercised invalid input,
a missing Worker, and the begin error from a closed pgxpool. Most of the
database preparation did not participate in those observations.

## Decision

The read-only test supplies a fixed Session principal and independent
unknown, not-committed and failing identity write outcomes to the real Broker.
The test records the identity operation and forbids later Worker storage or
an OAuth authority check. It retains the original error cause.

The snapshot test verifies that malformed credentials and input are refused
before accessing storage. The existing strict snapshot fixture supplies the
clock and missing Worker and confirms completion before the not-found result
is exposed. Report, List and Get still go through the real PostgreSQL Store
methods after a real pgxpool closes. The pool starts with no minimum
connections and refuses connection attempts. Each operation verifies its
Store begin error and original driver cause.

Live credentials, authority revocation, actual Worker observation, pagination,
expiry and transaction rollback remain with the physical tests.
[Worker admission test decision](2026-11-09-worker-admission-test-owners.md)

## Alternatives

**Prepare PostgreSQL for both tests.** This repeats schema and identity setup
for controlled outcomes and a failure before a query could run.

**Supply a synthetic Store error for a closed pool.** This could verify the
service wrapper but would leave the driver-to-Store begin error conversion
outside the test. A closed real pool exercises that path without connection
or schema setup.

## Consequences

The two refusal tests run without PostgreSQL or UniAuth fixture variables.
The closed-pool case still depends on pgxpool and the PostgreSQL Store.
Tests that observe real database rows and transaction behavior still use an
isolated PostgreSQL database.
