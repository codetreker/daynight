# Agent Note: GitHub Webhook Refresh Hints

Status: implemented

## Problem

Projects need timely PR and installation updates even when deliveries are duplicated, reordered, lost, or arrive while synchronization is running. An acknowledgement must not claim persistence when a database commit is uncertain.

## Decision

The original signed GitHub App endpoint persisted bounded PR or installation refresh hints before acknowledging relevant events, using a set-based transaction for matching enabled bindings. The later [reception cutover](2026-11-18-project-github-webhook-cutover.md) assigns PR deliveries to Project endpoints and retains App installation signals. The executor reads current GitHub facts and conditionally acknowledges the captured hint; periodic polling repairs missed deliveries. The [runtime design](../../../../docs/design/github-connection-runtime.md) describes deployment and reception.

## Alternatives

**Publish payload fields directly.** Delivery order and payload age do not establish current GitHub state; a later delivery could otherwise overwrite a newer observation.

**Rely only on polling.** It would delay ordinary updates until the next complete synchronization interval.

## Consequences

Repeated deliveries can cause another current read but do not require a delivery history. Lost or unconfirmed deliveries depend on polling for recovery. Installation signals invalidate active claims so access is checked before more publication.
