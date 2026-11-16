# Agent Note: Expanded member inner indent

Status: implemented

## Problem

Expanded Goal and chain members need a visible hierarchy offset while their
state backgrounds and borders meet both inner edges of the expanded content.
Moving whole rows leaves a neutral strip, whereas removing that inset without
replacing the content offset loses the hierarchy cue.

## Decision

The shared member list has no horizontal padding and supplies an additional
logical leading offset of 16px above a 600px viewport and 12px at or below it.
TaskRow applies that offset to its responsive base leading padding only for rows
in the shared list. Goal, full-chain and scoped-chain members therefore keep
their whole background and border aligned to the content edges while their
contents, including wrapped status and Session controls, remain indented.
Standalone and personal rows retain their base padding. The
[Web requirements](../../../../docs/spec/daynight-web.md#项目普通-task-行) own
the visible dimensions and interaction; the
[Web design](../../../../docs/design/daynight-web.md) owns style responsibilities.

This supplements the [edge alignment decision](2026-11-16-expanded-member-edge-alignment.md)
and restores the content position originally supplied by the external
[member inset](2026-11-16-expanded-member-inset.md), without restoring its
neutral strip.

## Alternatives

**Retain the external list inset.** Moving the whole row makes its background
and border miss the leading content edge, leaving a neutral strip.

**Keep only ordinary row padding.** This aligns the row edges but removes the
additional hierarchy offset from member content.

**Indent a title or each consumer separately.** A title margin omits metadata
and wrapped controls; separate consumer rules risk different offsets across the
three views. Applying an offset to every TaskRow also changes standalone rows.

## Consequences

The leading colored area belongs to the member row and retains its normal blank
area interaction. The extra content inset reduces available content width, so
long text and controls must still wrap without horizontal overflow. Chain bottom
spacing, Goal seams and empty-state padding remain independent of this rule.
