# Agent Note: Credential Usage Cancellation Test Time

Status: implemented

## Problem

The recorder cancellation test waits for real retry intervals even though it
needs to prove cancellation, retry exhaustion, and a drain that joins the
original worker and diagnostic consumer. The elapsed wall time is incidental to
those lifecycle assertions.

## Decision

The cancellation child runs in a standard library `synctest` bubble. Its real
recorder, writer, timers, contexts, and cleanup share virtual time. The test
observes the writer's cancellation before synchronously draining remaining work
and checks the original completed drain error and unpersisted count. A separate
cancelable parent and bounded cleanup stop both original producers even when the
test fails before its normal drain.

The [recorder lifecycle decision](../architecture/2026-11-12-credential-usage-recorder.md)
retains the production cancellation, drain and error contract.

## Alternatives

**Wait for real retry intervals.** This exercises native timer scheduling but
adds wall time without strengthening the cancellation and drain assertions.

**Manually advance the existing sampler clock.** This needs separate worker
wakeups and synchronization with retry completion while Drain runs concurrently;
the standard library bubble preserves the original synchronous drain sequence.

**Change production timing defaults.** A test-only timing requirement does not
justify changing the recorder or sampler interface or production intervals.

## Consequences

Production timers, retry limits and lifecycle logic remain in use; the bubble
advances their time without measuring native timer scheduling. Cleanup confirms
both producers have exited, including on assertion failures. Local case savings
alone do not establish an overall CI improvement.
