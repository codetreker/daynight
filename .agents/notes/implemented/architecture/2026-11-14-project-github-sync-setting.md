# Agent Note: Project GitHub Synchronization Setting

Status: implemented

## Problem

A Project administrator needs to stop PR updates while retaining the GitHub connection and previously observed data. A connection alone cannot express this intent, and a request already in flight on another server can otherwise publish after the administrator stops synchronization.

## Decision

Store synchronization intent separately from connection state, defaulting to off for new and existing Projects. Administrators explicitly enable it after connecting. A real switch advances the existing generation and clears claims and hints; admission, renewal and publication require the enabled setting and current lease. Already dispatched remote requests may finish, but old generations cannot publish after the disabling transaction commits. The [connection runtime](../../../../docs/design/github-connection-runtime.md) owns management and deployment, and the [storage design](../../../../docs/design/github-pr-storage.md) owns the migration and fence. This extends the [connection runtime decision](2026-11-13-github-connection-runtime.md), [storage decision](2026-11-13-project-github-pr-storage.md), [executor decision](2026-11-13-github-sync-executor.md), and [read decision](2026-11-13-github-pr-reads.md); the existing [settings decision](../feature/2026-11-13-github-connection-settings.md) retains the management and uncertainty boundaries.

## Alternatives

**Use connection as the synchronization switch.** Stopping updates would require disconnecting and later revalidating the App, so it cannot retain an independently usable connection.

**Leave existing Projects enabled during migration.** Existing work would continue without an explicit Project-level choice, contrary to the default-off behavior. Migrating all existing connections to off gives the setting one consistent initial meaning.

## Consequences

Disabling retains bindings, PRs and historical observations while clearing work and preventing stale publication. Re-enabling requires a full reconciliation, and events received while disabled are not accumulated. Existing synchronizing Projects require an administrator to enable them again after upgrade. All old replicas must be stopped and drained across migration because their admission path ignores the setting; mixed-version execution cannot enforce the stop guarantee.
