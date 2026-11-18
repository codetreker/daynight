# Agent Note: Project GitHub Webhook Receipts

Status: implemented

## Problem

Projects sharing a repository need independent receipt state and PR synchronization hints. A delivery verified against an old subscription or binding must not produce work after a conflicting configuration or authorization change commits. Receipt and queue writes must not become partially visible.

## Decision

An authenticated delivery enters the Project write transaction, which locks the live Project and connection before checking the subscription snapshot and current binding and grant facts. Valid receipts update the subscription timestamp; eligible PR deliveries also update PR receipt state and merge a hint in the existing per-Project, per-PR queue in the same transaction. The database supplies the time after the lock. The [design](../../../../docs/design/github-project-webhook-subscription.md#收件与提示) describes the admission and completion rules.

## Alternatives

**Use a separate queue for project deliveries.** This would duplicate the existing generation fence, claim, retry and request-ID acknowledgement mechanisms without adding a distinct execution requirement.

**Trust the signature snapshot for admission.** Configuration, connection and authorization can change while a delivery waits; checking those facts under the shared lock preserves their commit order.

**Use the HTTP request ID as the queue token.** An HTTP identifier can be reused and need not be a UUID. A separate generated UUID preserves the queue's acknowledgement fence, while logging both identifiers retains correlation.

## Consequences

Projects can record connectivity independently while unavailable or disabled PR synchronization does not enqueue work. Confirmed hints retain the existing runner's authorization and retry behavior. The HTTP adapter authenticates original bytes outside the transaction and honors the request deadline; the [reception cutover](2026-11-18-project-github-webhook-cutover.md) mounts it on the production route. Its receipt log links the HTTP request ID to the distinct queue UUID used to fence acknowledgements.
