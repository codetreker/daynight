# Agent Note: Controlled Azure Lease Renewal Ticks

Status: implemented

## Problem

The Azure archive lease renewal test must exercise SDK requests, refusal,
expiry and deadline extension. Waiting for the production 20-second interval
adds that delay to every execution even though elapsed time is not the behavior
under test.

## Decision

The lease constructor can supply a private tick channel to the renewal loop.
Ordinary construction creates and stops the 20-second ticker as before. The test
drives the loop explicitly while retaining the real SDK and controlled HTTP
server. A completion callback observes the successful renewal after the deadline
update, without issuing another request.

## Alternatives

**Shorten the production interval in tests.** A shorter timer still depends on
scheduling and elapsed time, and cannot establish when renewal has completed.

**Replace the SDK operation with a mock.** This would avoid the delay but lose
the request and response path that the test verifies.

## Consequences

The test no longer waits for the production interval, while production keeps
its original cadence, cancellation and join behavior. The controlled tick test
does not independently measure the production timer's wall-clock cadence.
