# Agent Note: Classify Controller relay disconnects

Status: implemented

## Problem

A timer tick can encounter a socket that has begun closing before its close
callback clears the connection. Reporting that expected transition as an offline
error makes normal reconnection look like a relay failure. An asynchronous tick
also must not send using a replacement connection's identity.

## Decision

Each tick captures its socket and fence, checks that both remain current and the
socket remains open before and after sending, and stops when they no longer do.
Only errors on the still-current connection are reported by the tick. Connection
creation failures, WebSocket error events and invalid frames retain their own
reporting paths. The [protocol design](../../../../docs/design/task-session-protocol.md)
describes the resulting connection behavior.

## Alternatives

**Ignore the offline error text.** A string-based exception would hide a real
failure on an otherwise current connection and would not prevent an old tick
from sending through a replacement socket.

## Consequences

Normal disconnects rely on the existing close callback and reconciliation to
resume durable work. Current-connection faults remain visible; a stale tick
cannot close the replacement connection or advance its send bookkeeping.
