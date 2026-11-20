# Agent Note: Webhook Maintenance Refusal Is Definite

Status: implemented

## Problem

The Web intent controller treated every dispatched 5xx response as an unknown
outcome. Creating an endpoint, adding subscriptions or events, confirming scope
or enabling an endpoint while `configurationExpansionAvailable=false` returns
`503 webhooks_unavailable`. The controller then persisted the prepared metadata
and looked up a receipt that was never written. The resulting 404 replaced the
maintenance error, and the unknown intent locked further edits. Reconciliation,
page reload and the end of maintenance could not recover it, because a missing
receipt does not prove rollback.

## Decision

A dispatched request that receives `503 webhooks_unavailable` ends as a definite
refusal: the controller keeps its error code, clears the pending body and stored
metadata, and starts no receipt lookup. Other 5xx responses remain unknown, and a
receipt 404 still does not establish rollback.

The service returns this code only from inside its webhook write transaction,
after the existing-operation lookup and before any effect. `transactMode` reports
that transaction as not committed only after a confirmed rollback; a failed
rollback leaves the outcome unknown, and the mutation and redelivery services
then answer `write_outcome_unknown`. A replay of an already recorded operation
returns its receipt and never reaches the maintenance check. The
[Webhook Web design](../../../../docs/design/webhook-web.md) owns the client rule;
the [management decision](../architecture/2026-11-08-webhook-web-management.md)
and [receipt decision](2026-11-08-webhook-receipt-results.md) own the shared
unknown-recovery and receipt rules.

## Alternatives

**Treat a receipt 404 after a 5xx as rollback.** Receipts expire and can be
collected, so a missing receipt cannot distinguish an uncommitted write from a
committed one whose receipt is gone.

**Rely on the page's `canSubmit` admission alone.** Admission uses the last
observed capability; maintenance can begin after that observation, and callers
without that capability, such as the assistant task inbox subscription panel,
would still lock on the service's refusal.

**Add a separate response field marking definite refusals.** The stable error
code already carries that guarantee for this case, and a new field would change
the shared wire contract for every Webhook error.

## Consequences

Maintenance refusals behave like other explicit refusals: the draft remains
editable and a later submission uses a new operation. The classification relies
on the service keeping `webhooks_unavailable` inside a rolled-back transaction; a
future path that returns this code after an uncertain commit must use
`write_outcome_unknown` instead.
