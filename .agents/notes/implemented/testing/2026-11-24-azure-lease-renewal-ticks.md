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
update, without issuing another request. A separate virtual-clock test starts
the lease through `Observe` and drives the ordinary ticker and SDK through an
in-process transport. It checks the renewal request, deadline and shutdown;
real Azurite tests retain the network and storage integration evidence.

## Alternatives

**Shorten the production interval in tests.** A shorter timer still depends on
scheduling and elapsed time, and cannot establish when renewal has completed.

**Replace the SDK operation with a mock.** This would avoid the delay but lose
the request and response path that the test verifies.

**Use a real socket inside the virtual clock test.** Network I/O is not governed
by the virtual clock, so waiting for a real server can prevent time advancing.
The in-process transport keeps the SDK request path without that dependency.

## Consequences

The tests do not wait for the production interval in wall-clock time, while
production keeps its original cadence, cancellation and join behavior. The
virtual-clock test covers the default timer connection but does not measure its
wall-clock cadence or replace the real Azurite integration tests.
