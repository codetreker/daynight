# Agent Note: WebSocket Connection Readiness in Lifecycle Tests

Status: implemented

## Problem

The active-connection lifecycle test read the server's count immediately after
client-side WebSocket dialing succeeded. The HTTP upgrade response can reach the
client before the handler registers the accepted connection. A valid scheduling
order therefore made the test report zero even though registration followed.

## Decision

Wait for an explicit handler readiness signal emitted after `routes.accept`
returns successfully before asserting that one connection is registered. Keep
the existing bounded context and fail if readiness is not reached. The close
assertion still waits for the handler's cleanup signal and requires zero active
connections.

The synchronization belongs only to the test. Server connection accounting,
WebSocket handshake order and production protocol behavior are unchanged.

## Alternatives

**Sleep before reading the count.** A fixed delay depends on runner scheduling
and either leaves the race possible or needlessly slows every successful test.

**Retry the count until it matches.** Polling can accommodate delayed registration,
but the handler can signal the exact completion point directly and preserve a
clear assertion about the lifecycle operation being tested.

## Consequences

The lifecycle assertions observe completed registration and cleanup without
weakening their expected counts. An accept failure or readiness timeout remains
a test failure. No production delay or retry is introduced.
