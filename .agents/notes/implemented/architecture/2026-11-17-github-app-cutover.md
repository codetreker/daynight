# Agent Note: GitHub App Runtime Cutover

Status: implemented

## Problem

A service-wide App cannot represent independent App administrators and Team grants. Switching only the server, data, runtime or Project client would leave active callers using incompatible authorization and connection identities.

## Decision

The server assembles independent App management, Team grants, Project connections, App-scoped webhook reception and the App-aware runner together with the Project and Team retirement coordinators. Project settings consume the corresponding protocol and Team settings expose the authorized-App projection. The runner drains before its credential provider and database close. [Connection and runtime](../../../../docs/design/github-connection-runtime.md) describes the deployed behavior.

Migration 077 clears old active bindings, claims and hints while retaining repository identity, PR observations and synchronization intent. All old replicas must stop and drain before migration; mixed versions cannot safely write the same data.

## Alternatives

**Keep a compatibility path or dual dispatch.** The old global identity cannot prove the current App and Team grant, and concurrent old writers could restore retired authorization after migration.

**Switch the Project client separately.** The previous server protocol cannot interpret the selected App and grant, so clients and server would disagree about connection authority.

## Consequences

Existing projects require an authorized App connection after upgrade, while retained PRs and synchronization intent remain visible. Credentials now belong to App resources rather than service-wide environment configuration. A coordinated stop and migration is required; returning to an older binary requires the corresponding database backup.
