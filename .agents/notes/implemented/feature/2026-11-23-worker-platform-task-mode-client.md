# Agent Note: Apply Worker platform task modes

Status: implemented

## Problem

A Worker that must reserve its capacity for tasks explicitly requiring its host
platform cannot use the two-state preference: it falls back to unrestricted
work. Independently upgraded services and Workers also need to preserve the
meaning of saved targets and actual application results.

## Decision

The Worker negotiates the [platform mode protocol](2026-11-23-worker-platform-task-mode-protocol.md)
and applies `all`, `prefer`, or `only` to subsequent acquisition. The existing
[platform preference decision](2026-11-09-worker-platform-task-preference.md)
retains the independent Project rotations and filtered pagination; `only` uses
just the platform-specific stream and continues polling when it is exhausted.
The applied configuration snapshot fences candidates before a new claim, while
submitted and existing claims retain their original lifecycle.

Legacy services use the boolean view and support `all` and `prefer`. Local
bootstrap keeps the boolean input. The Worker reports actual application facts
rather than inferring successful application from the saved target or a legacy
projection. The [Worker design](../../../../docs/design/daynight-worker.md)
owns the runtime and cache mechanisms.

## Alternatives

**Enforce the rule at claim admission.** This changes the service's claim contract
and cannot preserve existing client behavior without an additional authority
or handshake. Selection remains a Worker policy; an older Worker may still
claim unrestricted tasks after downgrade.

**Fall back after exhausting strict candidates.** This consumes unrestricted
work when the operator explicitly chose to reserve capacity for the platform.
The Worker instead waits for another polling round.

## Consequences

Strict Workers may remain idle while unrestricted tasks are ready. The rule is
not a server-side admission guarantee, and downgrade cannot promise strict
selection. Configuration changes fence new candidate consumption without
interrupting acquired work. Older services cannot express `only`.
