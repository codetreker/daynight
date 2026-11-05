# Agent Note: Team Member Role Alignment

Status: implemented

## Problem

Independent member grids size their action columns from different button labels,
so role controls do not line up. A last-administrator explanation also changes
the vertical center of its role cell. The native arrow can sit against the edge
of the control, leaving uneven space around the role text and arrow.

## Decision

The Team roster shares column tracks across rows via subgrid. Identity, role
and action occupy the same row, with the last-administrator explanation in a
separate row. On narrow screens identity moves above the role and action, while
the explanation can span the available width. Team role selects use equal widths
and a noninteractive CSS arrow with balanced insets; the select retains its native
keyboard, focus, selection and disabled behavior. Project grant selects retain
their existing styling. The [Team members decision](../feature/2026-11-05-web-team-members.md)
owns membership behavior.

## Alternatives

**Fixed action column in every row.** A fixed width could align the columns but
must anticipate localized action labels and would reserve unnecessary space.
Shared tracks accommodate the actual labels across all members.

**Keep the platform arrow.** Its inset is controlled by the browser and cannot
be balanced reliably with the text padding. Drawing only the arrow permits the
desired spacing without replacing the select's interaction.

## Consequences

Long identities and explanations wrap without shifting the role column. Shared
tracks depend on CSS subgrid support, and custom arrow colors must remain legible
in disabled and forced-color states. The Project grant layout remains independent.
