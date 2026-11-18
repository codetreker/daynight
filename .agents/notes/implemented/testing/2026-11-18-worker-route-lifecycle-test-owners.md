# Agent Note: Worker Route Lifecycle Test Owners

Status: implemented

## Problem

`TestWorkerRoutesLifecycleAndInvalidRequests` initializes PostgreSQL and a
UniAuth gateway to assert Worker request parsing, response projection and
configuration protocol behavior. The same test writes a reported runtime model,
then reads it back and verifies that a subsequent report clears an omitted
runtime configuration. Changing the fixture requires keeping those two
persistence observations backed by real storage.

## Decision

The HTTP test registers production Worker routes with request logging and
Session cookie and Origin authentication. The callbacks verify request context,
credential and principal, Worker ID, full Report and PUT arguments, default page
limit and exact calls. Invalid query, body, protocol and method requests exercise
the registered routes and must leave the Worker callbacks unused.

Independent Report, Get, List, Configuration and PutConfiguration results drive
the legacy two-timestamp receipt, unavailable and observed task inventory,
assistant-host telemetry, local runtime model source, omitted runtime
configuration, list projection and configuration revision responses. The
operation fixture is shared with the capacity tests.
[Worker Report capacity decision](2026-11-09-worker-report-capacity-test-owners.md)

The Core test `TestWorkerRuntimeConfigurationValidation` checks the local model
and omission through report validation and snapshot construction. The PostgreSQL
test `TestWorkerSnapshotUpsertUnknownStaleAndObservedTime` checks the stored local
model and omission using fresh reads after writes. Core, service and Store tests
for bootstrap, update and conflicts cover configuration revision and admission.
[Worker configuration test decision](2026-11-09-worker-configuration-test-boundary.md)

## Alternatives

**Keep the database and gateway setup in the route test.** That retains one
combined HTTP and persistence scenario at the cost of repeating real credential
and storage setup to check parser refusals and wire responses.

**Build a mutable Worker fixture from captured Report calls.** That would make
read expectations depend on the input whose propagation is being tested. The
independent response facts keep that comparison explicit, and the real reads
exercise what the database actually stores.

## Consequences

The HTTP selection runs without PostgreSQL or UniAuth fixture variables. The
fresh snapshot checks still require PostgreSQL and exercise real serialization
and replacement for runtime configuration. HTTP response checks and stored
snapshot checks detect distinct regressions in the handling of the same fields.
