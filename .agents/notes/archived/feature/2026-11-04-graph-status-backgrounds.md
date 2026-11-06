# Agent Note: Graph Task Status Backgrounds

Status: implemented

## Problem

Task-list rows and graph cards use different background colors for the same
lifecycle state. Graph inspection also replaces task backgrounds with relation
colors, making the status cue change when tracing dependencies.

## Decision

Graph cards consume the list palette's default and hover background variables
through their own `data-task-status`. External cards use their task's status.
Selected and prerequisite cards retain outlines; external cards retain dashed
borders, and unrelated cards retain their subdued title and shadow treatment.
These roles preserve the background's lifecycle meaning. Existing overdue cards
and standalone rows share the palette's amber default and hover variables while
keeping their own warning borders and text.

`TaskNode` imports the shared palette so card backgrounds do not depend on a
list being mounted. Graph CSS consumes only the background variables and keeps
ownership of card geometry, borders, text and controls. This partially supersedes
the graph exclusion in the [original row decision](2026-10-28-task-status-backgrounds.md).
The [Web specification](../../../../docs/spec/daynight-web.md#任务条目状态背景)
owns visible colors; the [Web design](../../../../docs/design/daynight-web.md)
owns composition.

## Alternatives

**Copy the palette into graph selectors.** Separate literals can drift when the
list colors change and duplicate the overdue exception.

**Apply the complete list surface class to cards.** That class also controls
border colors and auxiliary text, overriding graph status borders and changing
presentation beyond background reuse. Cards consume the existing variables
without adopting those list rules.

## Consequences

Lists and graph cards use one background palette, including hover and overdue
states. Dependency inspection stays visible through outlines and edge emphasis.
Card geometry, lifecycle data and graph interaction ownership are unchanged.
Browser verification must include inspection roles, external cards, hover and
warning priority because those rules previously supplied competing backgrounds.
