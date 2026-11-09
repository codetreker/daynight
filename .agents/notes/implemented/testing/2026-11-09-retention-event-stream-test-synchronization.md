# Agent Note: Retention Event Stream Test Synchronization

Status: implemented

## Problem

The blocked-consumer Retention test treats receipt of its first event as evidence
that the background Pass has returned. Observation publication runs before the
deferred pass-lock release. While that lock is still held, every manual Pass can
return through TryLock without producing another event. The existing 350-call
limit therefore does not guarantee that the stream was filled.

The same test's original cleanup waits unconditionally for a consumer that may
still be waiting for its first event. An early startup failure can leave that
consumer blocked. Its single receive after Stop can also consume a buffered
event without observing that the channel underneath has been closed.

## Decision

The case configures the existing private Retention wait callback before Start.
It reports entry through a buffered notification and remains there until runtime
cancellation. The background loop reaches this callback only after Pass and its
deferred unlock have returned. Filling begins after both first-event receipt
and wait entry, within the original shared one-second startup budget.

The test retains its original at-most-350 sequential calls, real bounded stream,
nonblocking emission and actual drop observation. The consumer remains blocked
while the real Stop completes. Wait exit is observed, then every buffered event
is drained with an open-channel check until the stopped stream is empty.
Checking the final empty channel strengthens the original single-receive
observation while retaining the same Stop-does-not-close contract.

Cleanup is registered before startup. It cancels the owned parent, releases the
consumer once, bounds Stop and consumer exit with the existing one-second
boundaries, and reports background errors independently. First-event reception
also observes parent cancellation. No production hook, timer default, retry or
stream capacity changes are needed. The [bounded retention decision](../architecture/2026-11-08-webhook-retention.md)
owns the product lifecycle; the [test-writing rules](../../../../docs/writing_tests.md)
own test responsibilities and cleanup.

## Alternatives

**Wait only for the first event.** Publication establishes delivery to the
consumer, but the publishing Pass can still hold its lock.

**Increase the loop count or add a delay.** Neither establishes that the lock
owner returned. Additional calls can all take the same TryLock refusal path,
and elapsed time is not a completion observation.

**Fill the channel or increment drop counters directly.** That bypasses actual
Pass publication and cannot prove that a blocked consumer leaves maintenance
and Stop independent of event consumption.

**Add a production scheduling hook.** The existing wait callback already marks
the required post-Pass boundary without expanding the production interface.

## Consequences

The case has an explicit lifecycle precondition and bounded failure cleanup.
It still exercises real stream backpressure, drop accounting and shutdown.
Temporary scheduling probes can hold publication before unlock to distinguish
the original missing-drop failure from the corrected wait. Blocking-publication
fault supervision must drain continuously until publishers finish; releasing
one channel slot can leave the next publication blocked.

A source-supported allowed interleaving is distinct from an observed CI
schedule. Ordinary repeated passes or a successful CI retry do not establish
the original failure's exact cause. Probe outcomes and their source revisions
belong to the owning validation material.
