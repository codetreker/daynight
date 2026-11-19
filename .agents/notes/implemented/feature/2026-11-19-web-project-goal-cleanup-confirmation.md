# Agent Note: Web Project Goal Cleanup Confirmation

Status: implemented

## Problem

Transferring or deleting a Project can permanently remove Goal dependencies
within it and across its boundary. The existing confirmation must disclose
this consequence before authorizing the service to remove those relationships.

## Decision

Both Project Settings confirmations show the same localized warning covering
internal dependencies and both directions across Projects. After the user
confirms, the corresponding transfer or deletion request sends the explicit
cleanup header. Preview requests do not send it. Existing access admission,
exact deletion name, cancellation and write outcome handling remain in force.
The [server cleanup decision](../architecture/2026-11-19-project-goal-dependency-cleanup.md)
owns the atomic cleanup and legacy refusal contract.

## Alternatives

**Add a separate confirmation step.** The existing final confirmation already
captures the user's decision and can explain the complete consequence without
introducing another dialog or a separate authorization state.

## Consequences

The warning applies even when no Goal dependencies exist because previews do not
report the relationship set. The confirmation covers the relationships present
at the time of the operation rather than a potentially stale count. Legacy requests
with dependencies are refused by the service; unknown outcomes cannot be inferred
from a later read or automatically replayed.
