# Agent Note: Grant Project Revalidation Ownership

Status: implemented

## Problem

A passive effect from an earlier render can observe updated project freshness refs after a user starts pagination or foreground impact reading. Its stale loading state can then authorize an automatic project reread that aborts the current operation, losing the requested page or preventing the impact change from clearing old details.

## Decision

Automatic project revalidation starts only when the shared impact read controller has no current owner. The existing read lifecycle clears that owner and publishes state when the operation finishes, allowing any still-needed revalidation to proceed. The [Team grant design](../../../../docs/design/github-app-team-grants.md) describes the resulting behavior and the [grant decision](../architecture/2026-11-16-github-app-team-grants.md) owns the authorization and privacy protocol.

## Alternatives

**Rely on rendered loading state.** An older passive effect can run after a new operation acquires the controller but before its loading state is reflected in that effect's render.

**Disable automatic revalidation.** This avoids the competing read but leaves retained project details unchecked after foreground or admission changes.

## Consequences

An active page or impact read keeps ownership until it finishes or is otherwise invalidated. Required automatic rereads still use the existing cursor, access checks and error handling; the guard does not make separate reads an atomic permission snapshot.
