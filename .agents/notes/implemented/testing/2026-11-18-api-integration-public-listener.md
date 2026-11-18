# Agent Note: API Integration Public Listener

Status: implemented

## Problem

The API integration fixture needs a stable public origin for the Server and
UniAuth callback, including across Server restarts. Reserving an ephemeral port
and releasing it before starting the Server leaves a window in which another
process can bind it, causing startup to fail before the API flow begins.

## Decision

The fixture retains a loopback listener from before gateway startup through
cleanup and serves a reverse proxy on that public origin. The real Server binds
its own ephemeral loopback port. The fixture reads the Server lifecycle log for
its address and checks readiness directly before routing requests to it. Before
shutdown or restart it withdraws the backend; the same public origin and
callback then route to the new backend only after readiness. The proxy preserves
HTTP host and upgraded and streaming transport behavior. Existing process and
resource cleanup remains independently verified.

## Alternatives

**Release a reserved port and bind it in the Server.** This preserves the direct
connection but cannot eliminate the interval between release and bind.

**Pass the listener to the Server process.** This would require production
startup support for inherited sockets solely for this fixture and alter the
Server's existing startup contract.

## Consequences

The public port remains occupied throughout gateway startup and Server restarts,
while the Server still reports genuine bind failures for occupied addresses.
The proxy adds a transport hop and fixture lifecycle that require explicit
coverage for readiness, restart, streaming and WebSocket traffic. The assembled
API suite continues to exercise the real Server, gateway and isolated stores.
