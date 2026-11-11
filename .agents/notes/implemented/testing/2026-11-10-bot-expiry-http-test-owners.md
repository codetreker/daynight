# Agent Note: Bot Expiry HTTP Test Owners

Status: implemented

## Problem

The Root Bot expiry HTTP cases assembled the application and executed Service
and Core through DAO mocks to obtain fixed responses. Their HTTP observations
depended on unrelated assembly and business decisions. The same cases observed
registration identity and initial Session data, as well as a production Runtime
constructor path, so replacing the fixture alone would lose distinct evidence.

## Decision

The Bot package's Runtime and deletion HTTP matrices register the real Bot
routes, request authentication, logging, parser and response encoder with strict direct
operation callbacks. Each request supplies an independent result or refusal.
The blocked callbacks establish that the handler entered and waited for the
operation; they do not represent a database lock or rollback. The original
credential kinds, inputs, response projections and replay sequences remain. The
former Root fixture also registered routes locally and did not call `New`.

Core Session registration checks the complete inserted registration identity,
bytes and durable initial Snapshot, and independently checks the returned
initial Snapshot. Runtime's constructor test observes its production operation
bindings, Engine receiver, writer and deferred operation close. Core and Service
retain the credential recheck, replay and transaction completion decisions.
PostgreSQL owners retain real locks, database clock, rollback and fresh reads.
Proposed writes, supplied completion and live publication remain distinct.

This partially supersedes the [Root HTTP DAO boundary](2026-11-09-root-http-test-dao-ownership.md)
for these cases and complements the [Runtime service boundary](2026-11-09-bot-runtime-service-test-boundary.md).
The [test-writing rules](../../../../docs/writing_tests.md) own the general
layer responsibilities.

## Alternatives

**Keep the assembled application and DAO mocks.** This preserves the original
observations but makes protocol tests execute lower decisions and unrelated
application construction.

**Supply HTTP results without receiving the lower observations.** Fixed results
cannot prove the registration producer or production constructor bindings.
Those observations must remain with the mechanisms that produce them.

**Evolve mock state from proposed writes.** This would conflate a callback with
transaction completion and persistence. Independent results and completion facts
retain those distinctions.

## Consequences

The selected HTTP and receiving unit tests do not need PostgreSQL or UniAuth
fixtures. Physical expiry, locking and persistence remain independently tested
at the Store. The receiving tests have their own cost; local case timings do not
establish an equal saving in complete validation or hosted CI.
