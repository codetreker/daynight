# Agent Note: Preserve task property compatibility during blocked cutover

Status: implemented

## Problem

The ordinary Task pause marker also represents waits for external intervention.
Renaming it must preserve existing values and automatic-input behavior while
installed clients and cached Web pages cross the server upgrade.

## Decision

The server stores `blocked` as the sole property and accepts `paused` as a write
alias. Public property projections include both names with the same value when
present. The migration renames existing rows without changing task metadata or
capturing a business event. Web normalizes both representations for its caches
and sends `blocked:false` to unblock. Its [alias decision](2026-11-18-web-task-property-alias.md)
retains the cache rationale. The [property design](../../../../docs/design/daynight-task-properties.md)
owns the protocol, capacity and deployment details.

## Alternatives

**Negotiate a single property name per client.** This would protect an old Web
page without refresh, but requires negotiation on every full property response.
The supported cutover instead bundles the compatible Web with the server and
requires a refresh, while preserving old CLI and Worker reads through the alias.

## Consequences

Old and new names address one logical value and preserve absent, false and true.
Dual projection adds bounded response bytes and requires equivalent admission
accounting. Old writers must be drained before migration; returning to an old
server requires a matching database backup. The existing `task.paused` webhook
and independent Worker and personal-task fields retain their protocol names.
