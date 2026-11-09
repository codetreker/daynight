# Agent Note: Bounded HTTP Input

Status: implemented

## Problem

Unbounded request targets, pre-decoding cursor allocations and stalled body reads can consume transport and memory resources before business admission. MCP pre-reading also needs a concurrency limit independent of its tool budgets. Closing an oversized HTTP/1 chunked body can cancel the request context even while the peer remains connected and able to receive a rejection; suppressing that rejection produces an empty implicit HTTP 200.

## Decision

The HTTP/1 runtime bounds initial headers, raw targets and queries before routing. Cursor and fixed-secret lengths are checked before decoding. Short body reads use connection deadlines, preserve the original error and clear the deadline after EOF. Stream consumers can start the same deadline on their first read. Unread rejections close the connection. MCP reserves an independent input slot after authentication and retains it until HTTP and handlers release the input. The [server design](../../../../docs/design/daynight-server.md) owns the transport contract.

Definite body-limit and read-timeout failures use the same terminal response path, with a one-second socket write deadline and a separate bounded context retaining request values. The original business context is retained without reopening canceled work. After a successful flush on a reusable connection, the temporary write deadline is cleared. Response deadline, write and flush errors are exposed; an actual deadline-setup error on the production HTTP/1 writer aborts the connection. Ordinary business responses retain their cancellation checks, and uncertain transactions or cleanup failures cannot be reclassified as definite body refusals. The shared attachment reader marks an actually observed byte overflow with `ContentOverflowError`, retaining its domain Fault through unwrapping. The existing error-tree visitor accepts that marker only when all publication wrappers report `not_published` and transaction wrappers record an operation refusal without a commit attempt or failed cleanup. Generic capacity Faults and joined cancellation do not establish that terminal refusal.

Go 1.27.2 [body.Close](https://github.com/golang/go/blob/022c8636110ebac86a9b88724cda168ed713c21f/src/net/http/transfer.go#L1003-L1045) may drain remaining chunk framing and trailers. With the rejection's immediate read deadline, a resulting socket read failure [cancels the connection context](https://github.com/golang/go/blob/022c8636110ebac86a9b88724cda168ed713c21f/src/net/http/server.go#L803-L817). The context therefore cannot distinguish a disconnected client from this local cleanup effect. The original timeout-only independent response decision provided the required cancellation boundary; body-limit failures need that same boundary. Explicit flush observes buffered transport failures that a successful buffered Write may not reveal.

## Alternatives

**Apply a server-wide read timeout.** It would also bound long-lived Session, SSE, WebSocket and long-poll connections.

**Use the existing MCP Control budget for pre-reading.** Holding it while a tool asks for its own Control slot could reject admitted work, while pre-reading before any reservation permits concurrent buffers without a bound.

**Detach cancellation for every response.** It would allow ordinary business output after client cancellation and weaken the request lifecycle. Only definite terminal body refusals have an independent response attempt.

**Convert every capacity Fault into a body refusal.** Capacity faults can describe metadata or output admission rather than an observed upload byte. Wrapping the whole error tree also hides publication, transaction or cleanup uncertainty. A typed reader refusal lets the existing visitor retain those facts.

**Clear the read deadline before closing an oversized body.** Native body draining could then wait for missing framing or bytes, retaining input capacity beyond the existing rejection bound. It also cannot restore an already canceled context.

## Consequences

Socket reads and retained MCP input are bounded without changing dedicated protocol lifetimes. A writable peer receives the actual 413 or 408 even when local body cleanup canceled the request; an unwritable peer retains the real transport failure. Complete successful bodies preserve keepalive, and rejection does not enter or replay business operations. HTTP/2 requires a separate decompressed-header budget. Attachment and archive owners connect the streaming deadline at their own authorized read boundary.
