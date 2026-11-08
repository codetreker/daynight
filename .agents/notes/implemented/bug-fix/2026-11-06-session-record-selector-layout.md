# Agent Note: Compact Session Record Selection

Status: implemented

## Problem

The Session tab's execution-record selector stretched across wide task pages.
Below 600px, its label occupied a complete flex row and pushed Refresh beneath
it, reducing the space available to read the conversation.

## Decision

The original layout bounded only the direct record toolbar inside
`.task-session-host` to 500px. Its label and select group grew from a zero flex
basis, with a single-line label and a 96px select minimum, so record names did
not determine the closed control's width.

The group's min-content width included the label and that minimum selection
width. Refresh stayed beside it at supported phone widths. Outer flex wrapping
allowed the optional pagination button to move down when it could not fit.
Complete record names remained available in the native options.

The [automatic Task Session entry decision](../simplification/2026-11-06-automatic-task-session-entry.md)
supersedes the main-page selector and its layout. Historical records remain
available through Attachments; the original reasons for avoiding shared toolbar
changes remain relevant to the remaining terminal and attachment controls.

## Alternatives

**Change the shared toolbar rules.** Those rules also serve terminal views and
the attachment sidebar. Scoping the override to the Session tab preserves their
layout without coupling those surfaces to a record-selector width.

**Keep a zero minimum on the label group.** It allows the group to shrink below
the combined label and select minimum when pagination is present, so its
contents can collide with the buttons instead of wrapping the extra control.

## Consequences

The bounded layout recovered one row of conversation space on phones when
pagination was absent and kept Refresh adjacent on wide pages. Closed controls
truncated long labels while native options retained full names and keyboard
behavior. That layout change preserved history reads, selection persistence,
errors and pagination; their current entry semantics belong to the replacement
decision.
