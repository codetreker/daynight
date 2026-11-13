# Agent Note: GitHub Webhook Refresh Hints

Status: implemented

## Problem

Projects need timely PR and installation updates even when deliveries are duplicated, reordered, lost, or arrive while synchronization is running. An acknowledgement must not claim persistence when a database commit is uncertain.

## Decision

The signed GitHub App endpoint persists bounded PR or installation refresh hints before acknowledging relevant events. It uses a set-based transaction for matching enabled bindings. The executor reads current GitHub facts and conditionally acknowledges the captured hint; periodic polling repairs missed deliveries. The [runtime design](../../../../docs/design/github-connection-runtime.md) describes deployment and reception.

## Alternatives

**Publish payload fields directly.** Delivery order and payload age do not establish current GitHub state; a later delivery could otherwise overwrite a newer observation.

**Rely only on polling.** It would delay ordinary updates until the next complete synchronization interval.

## Consequences

Repeated deliveries can cause another current read but do not require a delivery history. Lost or unconfirmed deliveries depend on polling for recovery. Installation signals invalidate active claims so access is checked before more publication.
