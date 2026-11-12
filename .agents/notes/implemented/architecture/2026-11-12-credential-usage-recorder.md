# Agent Note: Credential Usage Recorder Lifecycle

Status: implemented

## Problem

Successful credential use must not wait for metadata persistence or diagnostics,
including during database and logging failures. The bounded sampler needs an
execution owner that can expose lost samples and stop without releasing resources
while background producers still use them.

## Decision

The service recorder explicitly starts one database worker and a separate
consumer for bounded fault summaries. It copies safe request correlation into
sampler state, applies a deadline to each batch, and retries only the idempotent
metadata write. The consumer acknowledges a copied fault revision after logging;
request-local rejections use a fixed collector supplied by the caller. Drain
seals admission and joins both producers. A completed drain can retain a failure
and lost-sample count; a timeout preserves the same work for a later join.
The [authentication design](../../../../docs/design/daynight-auth.md#凭据使用记录器)
owns the lifecycle and diagnostic contract. The
[sampling decision](2026-11-12-credential-usage-sampling.md) owns state selection
and capacity, and the [persistence decision](2026-11-12-credential-usage-persistence.md)
owns transaction outcomes and driver cleanup.

## Alternatives

**Write metadata during authentication.** Database pool waits, locks and failures
would affect the original authentication or refresh result, and request
cancellation could discard an event that already occurred.

**Queue individual diagnostic events.** A bounded dropping queue can lose the
subject and failure category during logging backpressure. Per-key summaries
retain those facts within the sampler's existing memory bound, at the cost of
admission failures when dirty slots occupy capacity.

## Consequences

A process crash or exhausted retries can lose samples; the recorder is not a
durable queue. Slow logging can delay shutdown and consume resident capacity,
but does not serialize request admission or database work. The recorder joins
its own goroutines, while persistence closes and joins driver resources. App and
protocol integration are separate responsibilities.
