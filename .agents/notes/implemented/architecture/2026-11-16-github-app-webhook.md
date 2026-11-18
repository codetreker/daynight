# Agent Note: App-Scoped GitHub Webhook Hints

Status: implemented

## Problem

An independently managed GitHub App can serve multiple Teams, but a delivery must not restore a connection after its grant, owner, credentials, or App has changed. A signature check alone cannot freeze those facts while the request body arrives or while a transaction waits for locks.

## Decision

The App-scoped receiver authenticates the raw body with a live secret snapshot outside the transaction. A short signal transaction rechecks the credential version under the App lock, then locks current grants and candidate connections in the shared order and rechecks eligibility after waiting. Only a confirmed commit acknowledges a relevant event. The [design](../../../../docs/design/github-app-webhook.md) describes the HTTP and routing contract; the adapter is mounted on the production App-scoped route. The later [reception cutover](2026-11-18-project-github-webhook-cutover.md) assigns PR deliveries to Project endpoints while retaining App installation signals.

## Alternatives

**Hold the App lock while reading the body.** A slow sender could block credential changes, revocation and deletion for the entire upload.

**Trust the signed payload as a current PR observation.** Deliveries can be late, duplicated or reordered; hints followed by current GitHub reads preserve the existing [reception decision](2026-11-13-github-webhook-reception.md).

## Consequences

A credential change between authentication and the transaction refuses the delivery, and polling recovers missed hints. Locks and bounded request time limit contention but do not guarantee a particular fanout throughput. Tombstoned App identities cannot revive an old URL; same-secret signatures alone do not provide cryptographic replay prevention.
