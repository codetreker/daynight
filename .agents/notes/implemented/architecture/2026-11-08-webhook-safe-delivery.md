# Agent Note: Webhook Delivery Admission and Recovery

Status: implemented

## Problem

A persisted notification can outlive its original permissions, destination, process and network connection. Sending before recording an admission can lose accountability, while a stalled executor can return after another instance has recovered its work.

## Decision

A short FIFO claim is followed by a separate authorization and Attempt transaction; only a confirmed admission commit permits HTTP. Immutable capture facts and original subscription identities remain the basis for each admission. Delivery leases and generations fence current state, while retained Attempts separately record unknown recovery and late observations. A revision-scoped wait coordinates receiver delays. The [delivery design](../../../../docs/design/webhook-delivery.md) describes the network and lifecycle boundaries.

## Alternatives

**Send directly after claim.** Claiming does not prove continued authorization or persist an attempt, so failures and revocations could leave an unaccounted external request.

**Treat a lease as external deduplication.** A paused process can outlive its lease and still reach the receiver; discarding its later response would lose a real acknowledgement.

**Reconstruct eligibility from current subscriptions.** A new subscription or restored permission could inherit a historical event that its original proof no longer authorizes.

## Consequences

The [plaintext storage decision](../simplification/2026-11-08-webhook-plaintext-storage.md) preserves HMAC request signing and immutable target snapshots while storing target configuration and signing secrets directly in the database. The system retains durable attempts and performs a current authorization transaction before each send. Retry budgets and receiver waits remain bounded by the original deadline. Receivers must still deduplicate stable event IDs because recovery can repeat an external request. [Manual redelivery](2026-11-08-webhook-history-redelivery.md) registers a new intent for the same runner; the [retention decision](2026-11-08-webhook-retention.md) describes reclamation. The [application runtime](2026-11-08-webhook-application-runtime.md) supervises the sender and coordinates its shutdown.
