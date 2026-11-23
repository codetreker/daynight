# Agent Note: Worker Read-only Broker Cancellation Test Time

Status: implemented

## Problem

The Broker caller-context regression test waits for four real 500-millisecond
deadlines. Its purpose is to prove that interrupted authorization ends one
request while the shared Worker connection and another in-flight request remain
usable. Native timer scheduling does not strengthen those assertions.

## Decision

Each of the eight cancellation and deadline children runs in its own
`testing/synctest` bubble. The real Broker, connection, request goroutines,
channels, contexts and cleanup share virtual time. The deadline remains 500
milliseconds, and the authorization-entry signal precedes cancellation or
waiting for expiry. The test retains wrapped context errors, timeout and
cancellation classification, successful delivery of the other request, and the
final connection check.

A cancelable parent covers both request contexts. Cleanup cancels that parent,
closes the Broker and performs a bounded join of both request goroutines,
including when an assertion fails before either request completes. Buffered
answer channels allow each request to finish without requiring its normal
result consumer.

The [read-only channel decision](../architecture/2026-11-06-worker-readonly-channel.md)
owns the production connection and caller-authorization contract.

## Alternatives

**Keep real deadlines.** This preserves the same cancellation and shared-channel
observations while adding two seconds of waiting to every complete matrix run.

**Shorten the deadline.** A smaller real timeout couples authorization readiness
to machine scheduling and changes the existing timing conditions. Virtual time
retains the deadline and the explicit authorization barrier.

## Consequences

The matrix exercises the original production timeout and authorization paths
without their wall-clock deadline cost. Each child owns and joins its concurrent
work on success and assertion failure. The bubble does not measure native timer
scheduling, and case or package savings alone do not establish an overall CI
improvement.
