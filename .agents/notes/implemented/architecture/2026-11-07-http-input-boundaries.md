# Agent Note: Bounded HTTP Input

Status: implemented

## Problem

Unbounded request targets, pre-decoding cursor allocations and stalled body reads can consume transport and memory resources before business admission. MCP pre-reading also needs a concurrency limit independent of its tool budgets.

## Decision

The HTTP/1 runtime bounds initial headers, raw targets and queries before routing. Cursor and fixed-secret lengths are checked before decoding. Short body reads use connection deadlines, preserve the original error and clear the deadline after EOF. A timeout cancels business work and uses a separate bounded response attempt; unread rejections close the connection. Stream consumers can start the same deadline on their first read. MCP reserves an independent input slot after authentication and retains it until HTTP and handlers release the input. The [server design](../../../../docs/design/daynight-server.md) describes the transport contract.

## Alternatives

**Apply a server-wide read timeout.** It would also bound long-lived Session, SSE, WebSocket and long-poll connections.

**Use the existing MCP Control budget for pre-reading.** Holding it while a tool asks for its own Control slot could reject admitted work, while pre-reading before any reservation permits concurrent buffers without a bound.

## Consequences

Socket reads and retained MCP input are bounded without changing dedicated protocol lifetimes. A timed-out connection is closed, and a 408 can only be attempted while it remains writable. HTTP/2 requires a separate decompressed-header budget. Attachment and archive owners connect the streaming deadline at their own authorized read boundary.
