# Agent Note: Bounded Credential Usage Sampling

Status: implemented

## Problem

Credential use can be much more frequent than a useful update of approximate
last-use metadata. The system needs to preserve real, nondecreasing events within
a bounded memory budget while preventing hot credentials, database failures, or
slow diagnostics from silently displacing other pending work.

## Decision

The pure credential usage sampler maintains bounded per-key state and selects
due snapshots fairly. It retains a newer event that arrives during a write,
limits retries, and uses monotonic scheduling independently of event timestamps.
Unconfirmed, fixed-category fault summaries share the resident capacity and are
acknowledged by revision. Exhausted keys retain a bounded marker until a newer
event succeeds, preventing eviction from giving the same event a fresh budget.
The [authentication design](../../../../docs/design/daynight-auth.md#凭据使用事件采样规则)
describes the bounds and state transitions. The separate
[persistence decision](2026-11-12-credential-usage-persistence.md) owns the
ordered transactional writer and its database failure semantics.

## Alternatives

**Write every use synchronously.** This couples authentication latency and
availability to metadata writes and spends database capacity on events that the
approximate display does not need.

**Reset a key's deadline on every event.** Continuous traffic could postpone
the key indefinitely, so merging retains its existing due time.

**Use a dropping diagnostic queue.** A slow consumer could lose the resource and
failure category needed to explain recording failures. Fixed per-key summaries
retain these facts within the same capacity bound, at the cost of refusing new
keys while unconfirmed faults occupy all slots. Exhausted markers can likewise
hold slots after their diagnostics are acknowledged, until newer events succeed.

## Consequences

The sampler retains bounded recent state rather than a complete audit trail.
Admission failure and exhausted retries can lose samples and must be surfaced by
the eventual recorder. The pure rules do not start a worker, persist events, or
publish diagnostics. The normal scheduling budget depends on the worker and
database meeting their stated timing conditions; it is not a production
throughput guarantee.
