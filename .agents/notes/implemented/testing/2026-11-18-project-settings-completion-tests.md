# Agent Note: Project Settings Completion Tests

Status: implemented

## Problem

The Project settings cancellation matrix created a separate PostgreSQL schema
and seeded users and a project for each cancellation point. Several cases
checked how the Service handles an error or failed completion without exercising
a changed row that needed a database readback.

## Decision

Project settings tests use a controlled project writer and its scoped DAO for
query cancellations and failed completions following a refusal or no-op. The
real Service callback and Core settings rules determine the requested operation.
The writer supplies the completion outcome independently of the callback so the
tests can verify precedence, error propagation, and suppression of an
unconfirmed result.

The cancellation after a real settings UPDATE retains a PostgreSQL test with
a separate readback of the saved project. PostgreSQL version overflow, pool
failure, and concurrent lock and authorization cases keep their physical
database boundaries.

## Alternatives

**Keep the SQL tracer for every case.** It ties read-only or pre-write errors
to SQL text and pays schema setup and cleanup even when the asserted behavior
belongs to Service completion handling.

**Control all settings failures through mocks.** A completion result can model
an error but cannot establish that PostgreSQL rolled back an executed UPDATE or
that queued writers observed authorization after acquiring the project lock.

## Consequences

The isolated cases can run without PostgreSQL. The complete package still uses
a real isolated database for the settings storage and concurrency tests, as well
as other Project behavior. The two test scopes still exercise the same Service
entry point.
