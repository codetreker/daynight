# Agent Note: Worker Fixture Peer Disconnects

Status: implemented

## Problem

Canceling a worker RPC closes its Unix socket while the controlled Herdr fixture
may still be writing a response. An unhandled socket error terminates the fixture
daemon and leaves stale endpoints, so worker shutdown reports a daemon failure
rather than exercising its intended account and cleanup behavior.

## Decision

The installed-worker fixture records `EPIPE` and `ECONNRESET` as expected peer
disconnects. The error belongs to that connection and does not terminate the
fixture daemon. Other socket errors remain visible failures. Account isolation,
original-process stopping and cleanup assertions remain unchanged.

This follows the cancellation handling already used by the Herdr RPC unit
fixtures. The worker's production cancellation and daemon lifecycle are unchanged.

## Alternatives

**Retry the acceptance run without changing the fixture.** Cancellation can
reproduce the same unhandled response write and stale endpoints. A successful
retry would leave the underlying transport defect intact.

**Ignore every socket error.** Unexpected transport errors would stop proving the
fixture's behavior. Only the two expected peer-disconnect codes are accepted,
and their events remain observable.

## Consequences

Cancellation tests can close an in-flight connection while the fixture continues
serving later requests. Expected disconnects remain distinguishable from protocol,
process and cleanup failures. Controlled fixture results still do not qualify
native Herdr or model execution.
