# Agent Note: Detail Tag Summary Layout

Status: implemented

## Problem

In Task and Goal details, a block-width tag list forces the edit control onto a
separate line even when a short tag leaves enough room. The control also needs
clear spacing when tags wrap on narrow screens.

## Decision

The shared editor places the current tags and edit control in a wrapping flex
summary. Its local tag-list wrapper uses `display: contents`, so individual tags
and the control share the same flow. The list has no role, interaction or event
handler. Error and editing areas remain outside the summary. Other tag lists keep
their existing layout.

## Alternatives

**Keep the tag list as one flex item.** The control could sit beside a short
list, but could not follow the last line of a longer list even when space remains.

## Consequences

The summary wraps individual tags and the control with explicit spacing. Long
names can still wrap within their available width, and an empty collection keeps
the edit control without an empty-list placeholder. The existing display and
editing decisions remain in [tag display](../feature/2026-11-13-web-task-tag-display.md)
and [tag editing](../feature/2026-11-13-web-tag-editing.md).
