# Agent Note: Bound Integration Test Timing With Instance Intervals

Status: implemented

## Problem

Integration tests for upload renewal failure, search cancellation and image
decoder expiry must exercise real cancellation and failure handling. Waiting for
production intervals adds fixed cost when the observations concern the timeout
mechanism and its result, rather than the length of the interval.

## Decision

Upload services, search handlers and image decoders hold their timing intervals
per instance. Production construction retains the 20-second upload renewal
interval, five-second search deadline and 15-second image decode deadline. Tests
select shorter intervals while retaining actual timer expiry.

The upload test waits for storage opening before injecting a renewal failure and
checks the failure and unpublished outcome. The PostgreSQL search test observes
its query active before accepting deadline cancellation. Completion failure tests
wait for the real expired context before returning their errors. The
[snapshot cancellation decision](2026-11-06-snapshot-cancellation-observation.md)
owns the corresponding PostgreSQL transaction tests.

The image decoder's public constructor returns the decode method of its private,
validated instance. The internal deadline test checks that the same instance
constructor sets 15 seconds before selecting 200 milliseconds. It retains a real
helper process, observes its start marker, verifies that the decoder returns
`context.DeadlineExceeded` while its parent remains valid, and verifies that the
private staging directory is empty after the child has exited and joined. Parent
cancellation remains a separate real-process case. Neither a decoder timeout nor
a caller disconnect declares the original image content invalid.

## Alternatives

**Keep production intervals in tests.** This exercises the same paths but adds
fixed waits unrelated to their cancellation and outcome guarantees.

**Return synthetic timeout errors.** This would not prove that the real operation
context expired or that cancellation interrupted an active query or helper
process.

**Shorten only the image decoder's parent context.** That exercises caller
cancellation and loses the proof that an internal decoder deadline is preserved
as a recoverable operation failure while the caller remains connected.

## Consequences

The tests retain real asynchronous timers, database queries, child processes and
failure paths while shortening incidental waits. Instance configuration avoids a
mutable package-wide timer shared by concurrent tests and adds no public decoder
runtime setting. Observation may fail under severe scheduling delays rather than
treating an expiry before query or process startup as proof of cancellation.
