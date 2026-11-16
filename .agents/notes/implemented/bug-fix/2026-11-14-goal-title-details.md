# Agent Note: Goal Title Details

Status: implemented

## Problem

In the project Goal list, readers expect the visible Goal title to open its
existing details. A disclosure-only title makes that destination harder to find,
while limiting expansion to the arrow would make inline contents harder to open.
Both actions need keyboard access and independent focus recovery.

## Decision

The Goal title is a native details button alongside the native disclosure
button in a non-interactive summary. The surrounding row delegates clicks on
non-interactive content and whitespace to disclosure, excluding interactive
controls. The title and the existing details button use the same Goal reader and
pass their actual trigger for focus restoration. The disclosure retains its
accessible summary and controls the inline children; Session and graph actions
remain independent. The completion-time keyboard hint remains on the existing
details button.

The [Goal row disclosure decision](2026-11-13-goal-row-disclosure.md) retains the
reason for a broad expansion target. The [Goal specification](../../../../docs/spec/daynight-goals.md)
owns the visible behavior and the [Web design](../../../../docs/design/daynight-web.md)
describes the control structure.

## Alternatives

**Keep the title inside the disclosure button.** This preserves the larger
native disclosure surface but prevents the title from opening details.

**Use only the arrow for disclosure.** This separates title and expansion but
removes the broad target for inline contents that the earlier decision established.

**Make the containing row an interactive button.** A parent button or button
role containing the title and other controls would create conflicting interactive
semantics and require those controls to suppress the parent action.

## Consequences

Title and disclosure are separate native keyboard stops; the rest of the
non-interactive heading continues to offer a broad pointer target for expansion.
Delegated clicks must exclude interactive descendants so that opening details,
the graph, or a Session does not also toggle the Goal. Details restore the
actual title or independent details trigger when it remains available, and use
the existing visible fallback when it does not.
