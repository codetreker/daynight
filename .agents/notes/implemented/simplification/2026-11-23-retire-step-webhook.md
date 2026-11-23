# Agent Note: Retire Step Webhook Events

Status: implemented

## Problem

Retiring Task Steps requires eliminating new Step notifications without disrupting
other subscriptions or making previously committed operation receipts unreadable.
Queued deliveries may still reference the original binding identities.

## Decision

The subscription catalog excludes `task.step_updated`, while normalization and
history retain its known type. New configuration intents reject it after receipt
and version checks. Step writes no longer capture Webhook facts. A transactional
migration retires active Step bindings and subscriptions left empty, advancing
one configuration version per affected endpoint. Other binding identities,
authorization epochs, destinations and keys remain intact. Existing delivery
admission checks the original bindings. The [management design](../../../../docs/design/webhook-management.md)
and [capture design](../../../../docs/design/webhook-capture.md) own the current behavior.

## Alternatives

**Keep advertising the event.** New subscriptions would accept a selection that
can no longer produce events.

**Delete history or rewrite queued deliveries.** Existing receipts and delivery
proofs would lose their original identities. The existing continuity check already
prevents new admission after binding retirement.

## Consequences

Old clients requiring six catalog entries need a compatible upgrade before the
five-entry catalog is deployed. Requests already admitted to the network cannot
be recalled; old processes must drain and stop before migration. This decision
extends the [management](../architecture/2026-11-07-webhook-management.md) and
[delivery admission](../architecture/2026-11-08-webhook-safe-delivery.md) decisions.
