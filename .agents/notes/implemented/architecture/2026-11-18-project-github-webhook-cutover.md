# Agent Note: Project GitHub Webhook Reception Cutover

Status: implemented

## Problem

Projects sharing an App need independent repository subscriptions and receipt
state. Changing the delivery source while old writers remain active can mix PR
and installation diagnostics or lose pending work, and an older binary cannot
start against a migration ledger it does not recognize.

## Decision

The production service mounts Project subscription management and authenticated
Project reception with the existing PR runner. App reception retains installation
and repository-access signals; authenticated App PR events produce no new hints.
Previously committed hints and claims retain their existing generation and expiry.
The [runtime design](../../../../docs/design/github-connection-runtime.md) and
[server deployment instructions](../../../../packages/daynight-server/README.md)
own cutover and recovery conditions.

The [access diagnostics preparation](2026-11-18-github-access-diagnostics.md)
provides a build with the complete migration set while retaining App PR reception.
After old writers drain, activation can use the same ledger and later return to
that preparation build without discarding activation-era data. The
[Project receipt](2026-11-18-project-github-webhook-receipts.md) and
[subscription storage](2026-11-18-project-github-webhook-subscription.md)
decisions retain their separate admission and persistence rules. This partially
replaces [App-scoped reception](2026-11-16-github-app-webhook.md) and the original
[refresh-hint reception](2026-11-13-github-webhook-reception.md).

## Alternatives

**Continue broadcasting App PR deliveries.** This does not provide independent
Project subscription and receipt state, and running both sources would duplicate
delivery work while obscuring which configuration received an event.

**Introduce a migration in the activation build.** A preparation binary would
reject the new ledger, requiring backup restoration and loss of subsequent writes
instead of the same-database rollback afforded by an identical ledger.

## Consequences

Existing queues and polling keep their recovery behavior while new Project
subscriptions control immediate PR delivery. Deployment must drain each outgoing
version and compare the entire version and checksum ledger. A rollback window
requires retaining App PR subscriptions and coordinating repository hooks;
without a matching ledger, restoration uses a verified backup and may lose later
writes.
