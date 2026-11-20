# Agent Note: Give attachment uploads the container width

Status: implemented

## Problem

A phone-width attachment sidebar leaves too little room to identify a chosen
file or inspect its destination. The adjacent empty preview retains most of the
width while the upload form wraps across several vertical scrolls. A narrow Task
dialog has the same constraint even inside a wide browser window.

## Decision

The shared Task and Goal attachment panel measures its own available content
width. Below 560 CSS px, opening upload temporarily fills that panel with the
upload editor. At wider widths it retains the sidebar disclosure. One mounted
form and native file input own the draft in both layouts and while closed.
Background browsing retains its geometry and state while unavailable for focus
in the narrow editor. Its file menus close with focus transferred into upload
controls, because their original triggers become inert; independent delete
confirmations retain their own focus ownership and return focus into upload when
their original trigger becomes inert. Back and Escape return to browsing; successful upload
reveals and focuses the uploaded file. The [attachment design](../../../../docs/design/daynight-task-attachments.md#web-文件树与预览)
owns layout, draft lifetime, focus and error behavior.

## Alternatives

**Increase the permanent sidebar width.** This consumes the preview space during
ordinary file browsing and still couples upload editing to a separate reading
purpose.

**Render separate narrow and wide forms.** This replaces the native file input
when crossing the breakpoint, losing its selected File or requiring two draft
owners and explicit synchronization.

## Consequences

Phone layouts expose a readable filename and destination while preserving the
existing upload protocol and browser state. Container measurement adds a layout
observer, and the temporary editor requires explicit focus and scroll ownership.
The breakpoint applies to embedded dialogs as well as standalone pages; layout
and focus behavior require real-browser verification.
