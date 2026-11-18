# Agent Note: Project GitHub Webhook Subscription Storage

Status: implemented

## Problem

Projects sharing a GitHub App need independent repository webhook configuration. A configuration write must not succeed on a stale binding or grant, and ordinary project state must not expose the HMAC secret. Disconnection and access loss must not silently erase the configuration.

## Decision

Store the subscription on the existing project connection row with its own version and receipt state. The Project write transaction locks the active Project and connection before reading current binding and grant facts. Project deletion clears the subscription in the same transaction, including disconnected rows. The [design](../../../../docs/design/github-project-webhook-subscription.md) owns the storage and API contracts.

## Alternatives

**Use a separate subscription table.** This would add a separate lifecycle and locking relationship even though initial configuration requires an existing connection and the subscription survives disconnection on that row.

**Reuse the connection version.** Subscription edits and connection changes have different owners and would create unrelated version conflicts; a separate version still needs the shared connection lock to protect binding and grant facts.

## Consequences

Projects can configure the same repository independently and change or disable a subscription without changing connection scheduling. The secret remains available to narrowly scoped verification and configuration operations, so its storage and diagnostic boundaries must be maintained. The [reception cutover](2026-11-18-project-github-webhook-cutover.md) mounts the management and receipt adapters together.
