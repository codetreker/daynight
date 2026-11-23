# Agent Note: Compact Project Overview Statistics

Status: implemented

## Problem

Overview statistic cards consume vertical space with explanations beneath counts,
leaving less room for the progress list and task navigation.

## Decision

The seven overview cards display only their existing labels and full-history
counts. Their vertical padding and number spacing are reduced without fixing the
height, so long localized content can wrap. The independent progress list retains
its own scope and percentages. The [Web specification](../../../../docs/spec/daynight-web.md#必须交付的行为) owns the visible behavior.

The earlier [project sections decision](../../archived/feature/2026-10-25-project-overview-task-sections.md)
introduced the overview; this decision changes the cards' presentation while
retaining their shared snapshot and navigation.

## Alternatives

**Keep the explanatory lines.** They convey count details at a glance but retain
the vertical space that obscures more of the progress list. The labels and numbers
remain visible, while the independent progress list retains its own detail.

## Consequences

Cards are shorter for ordinary single-line content, with no empty explanation
rows. The breakdown and completion percentage are no longer displayed on cards;
counts, responsive columns, status colors and snapshot behavior remain unchanged.
