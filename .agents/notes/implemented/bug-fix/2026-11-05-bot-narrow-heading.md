# Agent Note: Give narrow Bot headings their full content width

Status: implemented

## Problem

The assistant conversation header places its close link beside the name and
status. In a narrow conversation column, the link's fixed width leaves too
little space for a normal name. The name wraps into a tall narrow column and
reduces the space available for reading messages. Long host names and unbroken
identifiers also need to remain readable without pushing the details marker
outside the name button.

## Decision

The [management page](../../../../docs/design/bot-management-web.md) makes the
conversation an inline-size query container. At available widths up to 420px,
the close link occupies the first row and the name and status use the full
second row. Wider columns retain the compact horizontal arrangement. The name
keeps its 19px heading size, supports natural wrapping and allows unbroken text
to wrap when necessary. The details marker retains its width, while the name
and status items can shrink within their available space.

The [details composition](../feature/2026-11-05-bot-details-panel.md) retains its
existing button semantics, focus ownership and fullscreen boundary. Header
layout is CSS-only: it does not change Bot selection, Session identity, request
admission or runtime lifecycle. Closing the conversation remains navigation to
the assistant list.

## Alternatives

**Use the existing narrow-window breakpoint.** The conversation can be narrow
inside a wide workspace with navigation and list columns. A window threshold
does not describe the space the heading receives; container width also handles
the same conversation entering fullscreen without another JavaScript state.

**Keep the horizontal layout and shrink or truncate its content.** Smaller text
weakens the title hierarchy, while truncation hides names or actual host and
failure information. Giving the close action its own row preserves that
information without a fixed header height.

## Consequences

Narrow names no longer compete with the close link for the same row. Long
content can still increase the header height, as preserving readable business
information requires. The outer navigation, assistant-list breakpoint, details
drawer breakpoint and Session composer retain their existing layout rules.

Browser regression checks measure the actual header, name button, marker and
status bounds across languages and viewport sizes. They also retain the same
Session DOM and draft while opening details and changing width. Controlled
Session writers establish Web presentation and request behavior only; native
Worker and Provider lifecycle evidence remains a separate acceptance boundary.
