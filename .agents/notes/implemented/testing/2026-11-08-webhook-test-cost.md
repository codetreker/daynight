# Agent Note: Webhook integration test cost

Status: implemented

## Problem

Webhook integration tests repeatedly wait for background polling and maintenance
budgets intended for deployed instances. Two redelivery scenarios also execute
the same complete manual-delivery sequence through different entry points.
Waiting longer or repeating that sequence does not add SQL, TLS or recovery
proof, but increases the cost of obtaining those observations.

## Decision

Runner instances retain a one-second poll interval. Retention instances retain a
one-second retry interval, a two-second pass deadline and a one-minute idle
interval. Private instance fields carry the first three durations, and test-only
setters configure shorter real timers before background work starts. Ordinary
receiver fixtures use a 20ms poll interval; production and stress construction
retain their original defaults. A default-policy test checks the deployed
values independently of timing-sensitive integration cases.

The HTTP redelivery scenario performs one real automatic delivery and one real
failed manual delivery. It retains authenticated admission, receipt replay,
stable event bytes and signatures, acknowledgement/error diagnostics, response
redaction, payload reads and HTTP budget-refusal mapping. The direct service
scenario retains all three manual operations, intermediate failure, final
success, generation changes and exhausted-budget rejection. The HTTP case
installs the already-established terminal budget as isolated fixture state
rather than replaying the remaining outbound sequence.

A real Retry-After receiver uses the shortest positive integer delay, one
second, with an earlier automatic slot. It checks persisted receiver wait,
absence of premature delivery, stable event bytes and both signatures.

Expiry interleavings advance a scoped clock only after an observed SQL lock or
actual TLS admission. The operation wrapper still queries PostgreSQL time and
advances only the returned operation observation; credentials, permissions,
locks and transactions remain real. Retention uses the existing scoped future
clock after the receiver has accepted the request, retaining immutable source
and payload facts while the real lease remains active. These cases prove clock
boundaries and ordering, rather than elapsed production-duration waiting.

## Alternatives

**Wait for production durations in every scenario.** This preserves the same
observations at the cost of repeated one-second polls and multi-second expiry
windows. Default-policy assertions and real short timers retain that proof with
less elapsed time.

**Return immediately from test waits or replace TLS and SQL with mocks.** This
can erase cancellation, asynchronous ordering and actual external effects. The
configured waits use real timers, and integration barriers remain actual
receiver arrival, database blocking or persisted readback.

**Remove the HTTP redelivery case.** The service sequence cannot prove HTTP
credentials, accepted/rejected status mapping, diagnostic encoding or redaction.
Those assertions remain at the real HTTP boundary.

**Use a smaller issuedAt margin before taking locks.** That margin includes
connection and transaction setup and can expire before the intended waiter is
observed. Scoped advancement occurs after the real blocking receipt instead.

## Consequences

Ordinary integration feedback avoids incidental production waits while retaining
real database, network, cancellation and cleanup mechanisms. Shorter polls can
increase database transaction frequency; complete package and module measurements
must assess that trade-off rather than infer a hosted speedup from timer values.
The [delivery design](../../../../docs/design/webhook-delivery.md) and
[retention design](../../../../docs/design/webhook-retention.md) continue to own
the production policies and durable lifecycle guarantees.
