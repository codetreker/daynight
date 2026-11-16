# Agent Note: UI Data Update Continuity

Status: implemented

## Problem

Local data changes can interrupt a user's reading or editing even when the
containing resource remains available. Closing and reopening a view, replacing
it with loading content, or resetting its viewport loses context that remains
valid. Background-check stability alone does not define the behavior when data
actually changes.

## Decision

The [UI principles](../../../../docs/ui-design.md#preserve-interface-continuity-when-data-changes)
require affected content and related information to update in place while valid
interaction state remains continuous throughout the update. Necessary layout
adjustments and internal full fetches or recomputation are allowed without
visible interruption or an automatic viewport reset. Resource deletion, identity
loss and access revocation retain their security cleanup; explicit navigation
and layout actions retain their own rules.

This extends the [background identity-check stability decision](../bug-fix/2026-11-05-stable-workspace-during-identity-checks.md)
from unchanged data to real changes. It also sets a stronger presentation
requirement than the [Goal graph deletion recovery](../bug-fix/2026-11-16-goal-graph-deletion-continuity.md),
whose epoch and access isolation rationale remains applicable.

## Alternatives

**Restore a view after the update.** Reopening a graph after new data is admitted
can recover its location but interrupts presentation and can lose its viewport
and inspection state. It does not preserve continuity throughout the operation.

**Require incremental internal reads and rendering.** Restricting fetches or
framework rendering would constrain implementation without guaranteeing visible
continuity. The rule instead governs the user's observable interface.

## Consequences

The requirement applies across UI development and review; product specifications
retain interface-specific behavior. Necessary cleanup and admission cannot be
bypassed by retaining stale private content. Existing ordinary-chain witness
closure and automatic framing do not yet establish the required continuity; the
[Goal graph implementation](../bug-fix/2026-11-16-goal-graph-stable-reconciliation.md)
keeps that graph mounted and preserves its viewport through reconciliation.
Implemented status records adoption of the specification, not runtime acceptance
of all consumers. No replacement graph host or witness algorithm is prescribed.
