# Agent Note: Assistant notification timing across hosting revalidation

Status: implemented

## Problem

Hosting-grant revalidation withdraws readiness while its authoritative query is
in flight, including for an unchanged valid grant. Filtering the Host's Bot
inventory by that transient value discards a whole minute delivery opportunity.
A submitted notification whose first receipt is only accepted can then wait
another minute for provider acceptance to be observed and its events acknowledged.
The combined schedule can exceed the 150-second inbound acceptance deadline.

A controlled schedule over the production coordination code observes this
mechanism. Historical CI logs lack the readiness and command identities needed
to prove the exact original interleaving or a unique historical root cause.

## Decision

Keep local Bot inventory independent of temporary hosting readiness. Before
new assistant actions, wait for the Bot process's serialized observation, then
check current recovery readiness and the authenticated Controller snapshot.
Migration, deletion, missing Session intent and stopped Bot filters remain with
their existing owners. Grant validation still immediately withdraws readiness;
the transport retains both hosting checks around Session preflight.

New events retain the independent minute cadence. For accepted, offered or
dispatching receipts, observe only the original operation every second for at
most ten seconds in the same delivery turn. The absolute deadline includes
requests and waits, and its cancellation is passed into each request. Provider
acceptance remains the sole prerequisite for event acknowledgment. Unknown and
failed receipts do not fast-poll. Receipt-query failure and observation expiry
retain the original journal for the next minute; they never grant permission to
submit a replacement command. Cancellation and shutdown join the observation
through the existing lane and Bot work responsibility.

The [Bot runtime design](../../../../docs/design/worker-bot-runtime.md#助手任务维护)
owns the resulting mechanism. This refines the timing in the
[maintenance decision](../architecture/2026-11-13-assistant-task-worker-runtime.md)
without replacing its claim, journal, application or lifecycle responsibilities.

## Alternatives

**Keep the previous verified grant during revalidation.** This would permit new
work while current authority remains unconfirmed. Keeping candidates and waiting
for serialized observation preserves the conservative gate.

**Poll all events more frequently.** This raises idle HTTP traffic for every Bot
and changes the established event cadence. Only already-submitted progressing
operations need short observation intervals.

**Introduce readiness subscriptions or per-Bot deadlines.** This adds scheduling,
subscription, cancellation and fairness state. The existing Bot process queue
already serializes grant revalidation with observation.

## Consequences

Valid in-flight revalidation delays health instead of discarding the minute
candidate. Prompt provider acceptance can be acknowledged in the same turn,
with at most ten extra receipt queries per progressing observation. A slow or
unavailable provider can still retain the journal beyond the current turn;
the deadline is an observation bound, not a guarantee of provider progress.

Deterministic Host/process/recovery tests prove candidate retention and gate
ordering. Receipt, real private-journal and cancellation tests prove original
identity, acknowledgment and joined recovery behavior. Product E2E retains its
normal journey and original deadline; passing CI does not fill historical
readiness evidence gaps.
