# Agent Note: Team Member Role Alignment

Status: implemented

## Problem

Independent member grids size their action columns from different button labels,
so role controls do not line up. A last-administrator explanation also changes
the vertical center of its role cell. The native arrow can sit against the edge
of the control, leaving uneven space around the role text and arrow.

## Decision

The Team roster shares column tracks across rows via subgrid. Identity, role
and action occupy the same row. On narrow screens identity moves above the role
and action. The original layout placed the last-administrator explanation in a
separate row to preserve alignment; the
[last-admin leave hint decision](../feature/2026-11-18-last-admin-leave-hint.md)
replaces that persistent row with an overlay anchored to the self-exit control.
Team role selects use equal 9.75em wrappers, capped by their column; Project
role selects retain 120px wrappers. Both use the filter density of the
[shared native select](../architecture/2026-11-14-shared-native-select.md).
The common component owns arrow geometry and state styling; the select retains
its native keyboard, focus, selection and disabled behavior.
The [Team members decision](../feature/2026-11-05-web-team-members.md)
owns membership behavior.

## Alternatives

**Fixed action column in every row.** A fixed width could align the columns but
must anticipate localized action labels and would reserve unnecessary space.
Shared tracks accommodate the actual labels across all members.

**Keep the platform arrow.** Its inset is controlled by the browser and cannot
be balanced reliably with the text padding. Drawing only the arrow permits the
desired spacing without replacing the select's interaction.

## Consequences

Long identities wrap without shifting the role column. The last-admin hint does
not participate in roster sizing. The Team width reserves space for the longest
default English role and the native arrow without changing between selections.
Shared
tracks depend on CSS subgrid support. Disabled and forced-color arrow treatment
belongs to the common component. The Project grant layout remains independent.
