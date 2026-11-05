# Agent Note: Compact Session Record Selection

Status: implemented

## Problem

The Session tab's execution-record selector stretched across wide task pages.
Below 600px, its label occupied a complete flex row and pushed Refresh beneath
it, reducing the space available to read the conversation.

## Decision

Only the direct record toolbar inside `.task-session-host` bounds its label and
select group to 500px. The group grows from a zero flex basis and keeps its
label text on one line. The native select also grows from zero, with a 96px
minimum, so record names do not determine the closed control's width.

The group's min-content width includes the label and that minimum selection
width. Refresh stays beside it at supported phone widths. The existing outer
flex wrapping lets the optional pagination button move down only when it cannot
fit. Complete record names remain available in the native options.

## Alternatives

**Change the shared toolbar rules.** Those rules also serve terminal views and
the attachment sidebar. Scoping the override to the Session tab preserves their
layout without coupling those surfaces to a record-selector width.

**Keep a zero minimum on the label group.** It allows the group to shrink below
the combined label and select minimum when pagination is present, so its
contents can collide with the buttons instead of wrapping the extra control.

## Consequences

Phone readers recover one row of conversation space when pagination is absent.
Wide layouts keep Refresh next to a bounded selector. Closed controls truncate
long record labels; native option selection retains the full names and existing
keyboard behavior. History reads, selection persistence, errors and pagination
retain their existing semantics.
