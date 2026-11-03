# Agent Note: Forced HTTP Close Ordering

Status: implemented

## Problem

After the HTTP drain deadline, canceling request contexts before closing their
connections leaves a response window. A canceled handler can return without
writing headers; net/http then emits its default success response before the
runtime closes the socket. The forced-shutdown guarantee requires those requests
to be aborted, including the shared runtime used by Session v2 routes.

## Decision

The runtime closes remaining HTTP connections before canceling the shared request
context. Connection closure cancels active HTTP requests without leaving a writable
response channel. Shared cancellation and relay shutdown still precede database
and file-resource release. Graceful draining retains its original deadline and
allows active requests to complete before it expires.

The [runtime foundation](../../archived/architecture/2026-10-19-server-runtime-foundation.md)
records the original separate ownership of signal and request contexts. This
decision refines forced-close ordering without changing that ownership.

## Alternatives

**Keep cancellation first and retry the acceptance check.** Scheduling can hide
the response window but cannot guarantee forced requests are aborted. A passing
rerun would not remove the race.

**Permit an HTTP response in the forced-shutdown test.** This weakens the existing
abort guarantee and does not address default success responses from canceled
handlers. The original acceptance assertions remain intact.

## Consequences

Forced shutdown cannot expose a completed response through an HTTP connection
that remained open after shared cancellation. A deterministic runtime regression
holds cancellation cleanup until the client observes its result, exercising the
ordering without a stress loop. Existing database cancellation, relay teardown,
graceful drain and built-binary shutdown checks continue to cover resource release.
