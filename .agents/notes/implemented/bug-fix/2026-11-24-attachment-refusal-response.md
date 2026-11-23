# Agent Note: Attachment Refusal Response Before Body Cleanup

Status: implemented

## Problem

An attachment upload can be refused before its request body is read. Closing
that body with an immediate read deadline can cancel the request context while
the peer can still receive a response. Suppressing the known refusal then leaves
an empty HTTP 200 instead of the promised error and request ID.

## Decision

The attachment HTTP handler sends an eligible, definite business refusal before
closing the unread body. It marks the connection for closure, bounds the socket
write, and sends the exact JSON content length before flushing with the original
request context. The complete response is framed before retained lease cleanup,
which can outlast the socket write deadline. The handler
then closes the body and releases the retained upload lease. Eligibility requires
a known refusal with reliable transaction and cleanup facts, no independent
joined failure, and no published or uncertain file effect. Business work retains
the original cancellation responsibility; transport failures remain failures.
The [HTTP input decision](../architecture/2026-11-07-http-input-boundaries.md)
continues to govern independent 408 and 413 responses.

## Alternatives

**Close before sending the refusal.** A native body close can read unfinished
framing against the expired deadline and cancel the request before the response
is encoded, even though its socket remains writable.

**Detach all business responses from cancellation.** This would attempt output
after unrelated cancellation and could obscure uncertain writes. Ordering the
known refusal first retains the original request's cancellation semantics.

## Consequences

Writable peers receive the mapped refusal and request ID without waiting for
unfinished input. Unread connections are not reused, and the response attempt
has a finite write deadline. A disconnected peer or a failed write cannot be
reported as successful delivery. Other HTTP callers and unknown publication or
transaction outcomes retain their existing handling.
