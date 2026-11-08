# Agent Note: Worker Read-only Test Timing

Status: implemented

## Problem

The read-only forwarding and shutdown tests exercise real HTTP and WebSocket
connections, but waiting for production deadlines and a fixed heartbeat window
makes their success depend on more than fifteen seconds of elapsed time. The
checks must retain timeout, cancellation, heartbeat, and shutdown evidence.

## Decision

Read-only routes use instance timing settings initialized to the production
operation timeout policy and five-second heartbeat interval. Integration tests
configure shorter values before serving requests. The forwarding test observes
the dispatched request and its fence, withholds the result, and checks the HTTP
timeout and matching cancellation. The shutdown test observes two actual Ping
frames; the second requires the server to have received the first Pong before
it begins shutdown. Virtual-time tests retain the HTTP admission deadline and
production default checks.

## Alternatives

**Wait for production intervals.** This exercises the same network path but
adds a fixed delay to every run. Separate timing-policy checks retain coverage of
the production defaults.

**Replace the heartbeat or timeout with a simulated response.** That would not
establish real WebSocket Ping/Pong, HTTP timeout, or cancellation behavior.

## Consequences

The integration tests still depend on real scheduling, authentication, and
network I/O. Their shorter intervals reduce waiting but do not measure hosted
CI savings by themselves. Production timing and operation budgets remain
unchanged.
